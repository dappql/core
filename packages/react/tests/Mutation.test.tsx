import * as React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook, waitFor, cleanup } from '@testing-library/react'
import { useMutation } from '../src/Mutation'
import { DappQLProvider } from '../src/Provider'
import { useAccount, usePublicClient, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { mockPublicClient } from './setup'

// Mock blocksHandler
vi.mock('../src/blocksHandler.js', () => ({
  useBlockNumberSubscriber: vi.fn(() => {
    return vi.fn((callback) => {
      return vi.fn() // Return unsubscribe function
    })
  }),
  BlockSubscriptionManager: vi.fn(() => ({
    subscribe: vi.fn(),
    onBlockUpdated: vi.fn(),
  })),
}))

const MUTATION_CONFIG = {
  contractName: 'TestContract',
  functionName: 'setValue',
  deployAddress: '0x123' as `0x${string}`,
  getAbi: () =>
    [
      {
        type: 'function',
        name: 'setValue',
        inputs: [{ type: 'uint256' }],
        outputs: [],
        stateMutability: 'nonpayable',
      },
    ] as const,
}

describe('useMutation', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    // Setup default mocks
    ;(useAccount as any).mockReturnValue({
      address: '0x456',
      chain: { id: 1 },
    })
    mockPublicClient.simulateContract = vi.fn()
    ;(usePublicClient as any).mockReturnValue(mockPublicClient)
    ;(useWaitForTransactionReceipt as any).mockReturnValue({
      isLoading: false,
      data: null,
    })
    ;(useWriteContract as any).mockReturnValue({
      writeContractAsync: vi.fn().mockResolvedValue('0xhash'),
      data: null,
      isPending: false,
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('initializes with correct default state', () => {
    const { result } = renderHook(() => useMutation(MUTATION_CONFIG, 'Set Value'), {
      wrapper: ({ children }) => <DappQLProvider>{children}</DappQLProvider>,
    })

    expect(result.current.isLoading).toBe(false)
    expect(result.current.send).toBeDefined()
  })

  it('handles transaction submission', async () => {
    const mockWriteContract = vi.fn().mockResolvedValue('0xhash')
    const mockOnMutationUpdate = vi.fn()
    ;(useWriteContract as any).mockReturnValue({
      writeContractAsync: mockWriteContract,
      data: null,
      isPending: false,
    })

    const { result } = renderHook(() => useMutation(MUTATION_CONFIG, 'Set Value'), {
      wrapper: ({ children }) => <DappQLProvider onMutationUpdate={mockOnMutationUpdate}>{children}</DappQLProvider>,
    })

    // Trigger mutation
    act(() => {
      result.current.send(123n)
    })

    // Verify writeContract was called with correct params
    expect(mockWriteContract).toHaveBeenCalledWith(
      expect.objectContaining({
        abi: MUTATION_CONFIG.getAbi(),
        functionName: MUTATION_CONFIG.functionName,
        address: MUTATION_CONFIG.deployAddress,
        args: [123n],
        chainId: 1,
        account: '0x456',
        connector: undefined,
      }),
    )

    // Verify onMutationUpdate was called with submitted status
    expect(mockOnMutationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'submitted',
        contractName: MUTATION_CONFIG.contractName,
        functionName: MUTATION_CONFIG.functionName,
        args: [123n],
      }),
    )
  })

  it('handles simulation when enabled', async () => {
    const mockSimulateContract = vi.fn().mockResolvedValue({})
    const mockWriteContract = vi.fn().mockResolvedValue('0xhash')
    ;(usePublicClient as any).mockReturnValue({
      simulateContract: mockSimulateContract,
    })
    ;(useWriteContract as any).mockReturnValue({
      writeContractAsync: mockWriteContract,
      data: null,
      isPending: false,
    })

    const { result } = renderHook(() => useMutation(MUTATION_CONFIG, { simulate: true }), {
      wrapper: ({ children }) => <DappQLProvider>{children}</DappQLProvider>,
    })

    // Trigger mutation
    act(() => {
      result.current.send(123n)
    })

    // Verify simulation was called
    expect(mockSimulateContract).toHaveBeenCalledWith({
      abi: MUTATION_CONFIG.getAbi(),
      functionName: MUTATION_CONFIG.functionName,
      address: MUTATION_CONFIG.deployAddress,
      args: [123n],
      account: '0x456',
    })

    // Wait for simulation and verify writeContract was called
    await waitFor(() => {
      expect(mockWriteContract).toHaveBeenCalled()
    })
  })

  it('signs with the account and connector the send was authorized for', async () => {
    // `writeContract` resolves the active connection inside its own mutation
    // function, and `simulate` is awaited before it. A wallet event landing in
    // either gap must not retarget a transaction whose arguments were built and
    // simulated for the previous account.
    const connectorA = { uid: 'connector-a' }
    const connectorB = { uid: 'connector-b' }
    ;(useAccount as any).mockReturnValue({ address: '0xAAA', chain: { id: 1 }, connector: connectorA })

    let resolveSimulation: (value: unknown) => void = () => {}
    const mockSimulateContract = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSimulation = resolve
        }),
    )
    const mockWriteContract = vi.fn().mockResolvedValue('0xhash')
    ;(usePublicClient as any).mockReturnValue({ simulateContract: mockSimulateContract })
    ;(useWriteContract as any).mockReturnValue({
      writeContractAsync: mockWriteContract,
      data: null,
      isPending: false,
    })

    const { result, rerender } = renderHook(() => useMutation(MUTATION_CONFIG, { simulate: true }), {
      wrapper: ({ children }) => <DappQLProvider>{children}</DappQLProvider>,
    })

    act(() => {
      result.current.send(123n)
    })

    // The wallet changes while the simulation is still pending.
    ;(useAccount as any).mockReturnValue({ address: '0xBBB', chain: { id: 1 }, connector: connectorB })
    rerender()

    await act(async () => {
      resolveSimulation({})
    })

    await waitFor(() => {
      expect(mockWriteContract).toHaveBeenCalled()
    })

    // Bound to the account and connector that authorized the send, so wagmi
    // fails the write rather than signing it with the wallet that replaced it.
    expect(mockWriteContract).toHaveBeenCalledWith(expect.objectContaining({ account: '0xAAA', connector: connectorA }))
  })

  it('reports the signed hash even if the component unmounts first', async () => {
    // TanStack runs per-call mutation callbacks only while the observer still
    // has listeners, so an `onSettled` passed to `writeContract` is dropped on
    // unmount, reset, or a superseding mutation. The transaction still
    // broadcasts — the user already approved it — and without this the hash is
    // never persisted, the receipt watcher never starts, and the `submitted`
    // notification is left with no terminal update.
    const mockOnMutationUpdate = vi.fn()
    let resolveWrite: (hash: string) => void = () => {}
    const mockWriteContractAsync = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveWrite = resolve
        }),
    )
    ;(useWriteContract as any).mockReturnValue({
      writeContractAsync: mockWriteContractAsync,
      data: null,
      isPending: false,
    })

    const { result, unmount } = renderHook(() => useMutation(MUTATION_CONFIG, 'Set Value'), {
      wrapper: ({ children }) => <DappQLProvider onMutationUpdate={mockOnMutationUpdate}>{children}</DappQLProvider>,
    })

    act(() => {
      result.current.send(123n)
    })
    expect(mockWriteContractAsync).toHaveBeenCalled()

    // The user closes the dialog while the wallet prompt is still open.
    unmount()

    // ...and then approves it.
    await act(async () => {
      resolveWrite('0xdeadbeef')
    })

    await waitFor(() => {
      expect(mockOnMutationUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'signed', txHash: '0xdeadbeef' }),
      )
    })
  })

  it('reports the signed hash even after reset', async () => {
    const mockOnMutationUpdate = vi.fn()
    let resolveWrite: (hash: string) => void = () => {}
    ;(useWriteContract as any).mockReturnValue({
      writeContractAsync: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveWrite = resolve
          }),
      ),
      data: null,
      isPending: false,
    })

    const { result } = renderHook(() => useMutation(MUTATION_CONFIG, 'Set Value'), {
      wrapper: ({ children }) => <DappQLProvider onMutationUpdate={mockOnMutationUpdate}>{children}</DappQLProvider>,
    })

    act(() => {
      result.current.send(123n)
    })

    // Resetting clears local state, but the wallet prompt it opened is still up.
    act(() => {
      result.current.reset()
    })

    await act(async () => {
      resolveWrite('0xafterreset')
    })

    await waitFor(() => {
      expect(mockOnMutationUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'signed', txHash: '0xafterreset' }),
      )
    })
  })

  it('reports both hashes when a second send supersedes the first', async () => {
    const mockOnMutationUpdate = vi.fn()
    const resolvers: Array<(hash: string) => void> = []
    ;(useWriteContract as any).mockReturnValue({
      writeContractAsync: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolvers.push(resolve)
          }),
      ),
      data: null,
      isPending: false,
    })

    const { result } = renderHook(() => useMutation(MUTATION_CONFIG, 'Set Value'), {
      wrapper: ({ children }) => <DappQLProvider onMutationUpdate={mockOnMutationUpdate}>{children}</DappQLProvider>,
    })

    act(() => {
      result.current.send(1n)
    })
    act(() => {
      result.current.send(2n)
    })
    expect(resolvers).toHaveLength(2)

    // Both were signed. A superseded transaction is still a real transaction,
    // and dropping its hash loses it entirely.
    await act(async () => {
      resolvers[0]('0xfirst')
      resolvers[1]('0xsecond')
    })

    await waitFor(() => {
      expect(mockOnMutationUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'signed', txHash: '0xfirst' }),
      )
      expect(mockOnMutationUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'signed', txHash: '0xsecond' }),
      )
    })
  })

  it('handles errors when no account is connected', () => {
    const mockOnMutationUpdate = vi.fn()
    ;(useAccount as any).mockReturnValue({
      address: null,
      chain: { id: 1 },
    })

    const { result } = renderHook(() => useMutation(MUTATION_CONFIG, 'Set Value'), {
      wrapper: ({ children }) => <DappQLProvider onMutationUpdate={mockOnMutationUpdate}>{children}</DappQLProvider>,
    })

    // Trigger mutation
    act(() => {
      result.current.send(123n)
    })

    // Verify error was reported
    expect(mockOnMutationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        error: new Error('No account connected'),
      }),
    )
  })

  it('uses addressResolver when available', () => {
    const mockAddressResolver = vi.fn().mockReturnValue('0x789')
    const mockWriteContract = vi.fn().mockResolvedValue('0xhash')
    ;(useWriteContract as any).mockReturnValue({
      writeContractAsync: mockWriteContract,
      data: null,
      isPending: false,
    })

    const { result } = renderHook(() => useMutation(MUTATION_CONFIG), {
      wrapper: ({ children }) => <DappQLProvider addressResolver={mockAddressResolver}>{children}</DappQLProvider>,
    })

    // Trigger mutation
    act(() => {
      result.current.send(123n)
    })

    // Verify correct address was used
    expect(mockWriteContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: '0x789',
      }),
    )
  })

  it('handles transaction confirmation states', async () => {
    const mockOnMutationUpdate = vi.fn()
    const mockTxHash = '0xabc'

    // Mock write contract to return a tx hash
    ;(useWriteContract as any).mockReturnValue({
      writeContractAsync: vi.fn().mockResolvedValue(mockTxHash),
      data: mockTxHash,
      isPending: false,
    })

    // Mock confirmation states
    ;(useWaitForTransactionReceipt as any).mockReturnValue({
      isLoading: true,
      data: null,
    })

    const { result, rerender } = renderHook(() => useMutation(MUTATION_CONFIG, 'Set Value'), {
      wrapper: ({ children }) => <DappQLProvider onMutationUpdate={mockOnMutationUpdate}>{children}</DappQLProvider>,
    })

    // Trigger mutation
    act(() => {
      result.current.send(123n)
    })

    // Verify signed status update
    expect(mockOnMutationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'signed',
        txHash: mockTxHash,
      }),
    )

    // Verify loading state
    expect(result.current.isLoading).toBe(true)

    // Mock confirmation complete
    ;(useWaitForTransactionReceipt as any).mockReturnValue({
      isLoading: false,
      data: { transactionHash: mockTxHash },
    })

    rerender()

    // Verify loading state updated
    expect(result.current.isLoading).toBe(false)
  })

  it('reports an error when the wallet rejects', async () => {
    const mockOnMutationUpdate = vi.fn()
    const mockError = new Error('Transaction failed')

    // Mock write contract to return an error
    ;(useWriteContract as any).mockReturnValue({
      writeContractAsync: vi.fn().mockRejectedValue(mockError),
      data: null,
      isPending: false,
    })

    const { result } = renderHook(() => useMutation(MUTATION_CONFIG, 'Set Value'), {
      wrapper: ({ children }) => <DappQLProvider onMutationUpdate={mockOnMutationUpdate}>{children}</DappQLProvider>,
    })

    // Trigger mutation
    act(() => {
      result.current.send(123n)
    })

    // Verify error status update
    expect(mockOnMutationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        error: new Error(mockError.message),
      }),
    )
  })

  it('handles simulation errors', async () => {
    const mockOnMutationUpdate = vi.fn()
    const mockError = new Error('Simulation failed')
    const mockSimulateContract = vi.fn().mockRejectedValue(mockError)

    // Mock public client with failing simulation
    ;(usePublicClient as any).mockReturnValue({
      simulateContract: mockSimulateContract,
    })

    const { result } = renderHook(() => useMutation(MUTATION_CONFIG, { simulate: true }), {
      wrapper: ({ children }) => <DappQLProvider onMutationUpdate={mockOnMutationUpdate}>{children}</DappQLProvider>,
    })

    // Trigger mutation
    act(() => {
      result.current.send(123n)
    })

    // Wait for simulation to fail
    await waitFor(() => {
      expect(mockOnMutationUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'error',
          error: new Error(mockError.message),
        }),
      )
    })

    // Verify writeContract was not called after simulation failure
    expect(useWriteContract().writeContractAsync).not.toHaveBeenCalled()
  })

  it('uses address from mutation options when provided', () => {
    const mockWriteContract = vi.fn().mockResolvedValue('0xhash')
    const customAddress = '0xabc123' as `0x${string}`
    const mockAddressResolver = vi.fn().mockReturnValue('0x789')

    ;(useWriteContract as any).mockReturnValue({
      writeContractAsync: mockWriteContract,
      data: null,
      isPending: false,
    })

    const { result } = renderHook(
      () =>
        useMutation(MUTATION_CONFIG, {
          address: customAddress,
          transactionName: 'Custom Address Test',
        }),
      {
        wrapper: ({ children }) => <DappQLProvider addressResolver={mockAddressResolver}>{children}</DappQLProvider>,
      },
    )

    // Trigger mutation
    act(() => {
      result.current.send(123n)
    })

    // Verify custom address was used instead of resolved or default address
    expect(mockWriteContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: customAddress,
      }),
    )

    // Verify address resolver was not called
    expect(mockAddressResolver).not.toHaveBeenCalled()
  })

  it('handles gas estimation', async () => {
    const mockEstimateGas = vi.fn().mockResolvedValue(200000n)
    ;(usePublicClient as any).mockReturnValue({
      estimateContractGas: mockEstimateGas,
    })

    const { result } = renderHook(() => useMutation(MUTATION_CONFIG, 'Set Value'), {
      wrapper: ({ children }) => <DappQLProvider>{children}</DappQLProvider>,
    })

    // Call estimate function
    const estimatedGas = result.current.estimate(123n)

    // Verify estimation was called with correct params
    expect(mockEstimateGas).toHaveBeenCalledWith({
      abi: MUTATION_CONFIG.getAbi(),
      functionName: MUTATION_CONFIG.functionName,
      address: MUTATION_CONFIG.deployAddress,
      args: [123n],
      account: '0x456',
    })

    // Verify the returned value
    await expect(estimatedGas).resolves.toBe(200000n)
  })

  it('handles gas estimation errors', async () => {
    const mockError = new Error('Gas estimation failed')
    const mockEstimateGas = vi.fn().mockRejectedValue(mockError)
    ;(usePublicClient as any).mockReturnValue({
      estimateContractGas: mockEstimateGas,
    })

    const { result } = renderHook(() => useMutation(MUTATION_CONFIG, 'Set Value'), {
      wrapper: ({ children }) => <DappQLProvider>{children}</DappQLProvider>,
    })

    // Call estimate function and expect it to throw
    await expect(result.current.estimate(123n)).rejects.toThrow('Gas estimation failed')
  })

  it('throws error when trying to estimate gas without a client', async () => {
    ;(usePublicClient as any).mockReturnValue(null)

    const { result } = renderHook(() => useMutation(MUTATION_CONFIG, 'Set Value'), {
      wrapper: ({ children }) => <DappQLProvider>{children}</DappQLProvider>,
    })

    // Call estimate function and expect it to throw
    await expect(result.current.estimate(123n)).rejects.toThrow('No client')
  })
})
