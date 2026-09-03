import { useCallback, useMemo } from 'react'

import { Chain, type Address, PublicClient } from 'viem'
import { useAccount, usePublicClient, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'

import { MutationInfo, type MutationConfig } from './types.js'
import { useDappQL } from './Context.js'
import { WriteContractErrorType } from 'wagmi/actions'

function useSimulate<M extends string, Args extends readonly any[]>(
  config: MutationConfig<M, Args>,
  address: Address,
  account: Address | undefined,
  chain: Chain | undefined,
  client: PublicClient | undefined,
) {
  return useCallback(
    async (...args: Args) => {
      if (!client) throw new Error('No client')
      return await client?.simulateContract({
        abi: config.getAbi(),
        functionName: config.functionName,
        address,
        args,
        account,
      })
    },
    [address, config, account, chain?.id, client],
  )
}

function useEstimate<M extends string, Args extends readonly any[]>(
  config: MutationConfig<M, Args>,
  address: Address,
  account: Address | undefined,
  chain: Chain | undefined,
  client: PublicClient | undefined,
) {
  return useCallback(
    async (...args: Args) => {
      if (!client) throw new Error('No client')
      return await client?.estimateContractGas({
        abi: config.getAbi(),
        functionName: config.functionName,
        address,
        args,
        account,
      })
    },
    [address, config, account, chain?.id, client],
  )
}

function useMutationConfirmation(hash: `0x${string}` | undefined) {
  return useWaitForTransactionReceipt({ hash })
}

/**
 * Configuration options for mutations
 * Can be either a string (transaction name) or an object with additional options
 */
export type MutationOptions =
  | {
      /** Human-readable name for the transaction */
      transactionName?: string
      /** Override the contract address */
      address?: Address
      /** Whether to simulate the transaction before sending */
      simulate?: boolean
    }
  | string

/**
 * Hook for executing contract write operations (mutations)
 * @param config Configuration object containing contract details and ABI
 * @param optionsOrTransactionName Optional configuration or transaction name
 * @returns Object containing mutation state and send function
 *
 * @example
 * const mutation = useMutation({
 *   contractName: 'MyContract',
 *   functionName: 'setValue',
 *   getAbi: () => CONTRACT_ABI,
 *   deployAddress: '0x...'
 * }, 'Set Value')
 *
 * // Execute the mutation
 * mutation.send(newValue)
 */
export function useMutation<M extends string, Args extends readonly any[]>(
  config: MutationConfig<M, Args>,
  optionsOrTransactionName?: MutationOptions,
): {
  status: 'pending' | 'success' | 'error' | 'idle'
  data: Address | undefined
  error: WriteContractErrorType | null
  isPending: boolean
  isSuccess: boolean
  isError: boolean
  isLoading: boolean
  failureCount: number
  failureReason: WriteContractErrorType | null
  isIdle: boolean
  submittedAt: number
  confirmation: ReturnType<typeof useMutationConfirmation>
  reset: () => void
  send: (...args: Args) => void
  simulate: ReturnType<typeof useSimulate<M, Args>>
  estimate: ReturnType<typeof useEstimate<M, Args>>
} {
  const { addressResolver, onMutationUpdate, simulateMutations } = useDappQL()

  const { chain, address: account, connector } = useAccount()

  const tx = useWriteContract()
  const client = usePublicClient()

  const address = useMemo(
    () =>
      optionsOrTransactionName && typeof optionsOrTransactionName !== 'string' && optionsOrTransactionName.address
        ? optionsOrTransactionName.address
        : addressResolver?.(config.contractName.toString()) || config.deployAddress!,
    [config.contractName, addressResolver, JSON.stringify(optionsOrTransactionName)],
  )

  const options = useMemo(
    () =>
      typeof optionsOrTransactionName === 'string'
        ? { transactionName: optionsOrTransactionName }
        : optionsOrTransactionName,
    [optionsOrTransactionName],
  )

  const mutationInfo = {
    account,
    address,
    contractName: config.contractName,
    functionName: config.functionName,
    transactionName: options?.transactionName || '',
  }

  const simulate = useSimulate(config, address, account, chain, client)
  const estimate = useEstimate(config, address, account, chain, client)
  const send = useCallback(
    (...args: NonNullable<Args>) => {
      const now = Date.now()
      const id = mutationInfo.address + mutationInfo.functionName + now.toString()

      // Captured when the caller asks to send, and used for the write below.
      //
      // `writeContract` resolves the active connection inside its own mutation
      // function, which runs after a yield — and after `simulate` below, which
      // is awaited. A wallet event landing in either gap would otherwise sign
      // with whoever is connected then, against arguments built and simulated
      // for whoever was connected when the caller decided to send. Binding both
      // makes wagmi fail that write instead of retargeting it.
      const boundAccount = account
      const boundConnector = connector

      if (!account || !chain?.id) {
        const error = !account ? 'No account connected' : 'Invalid chain'

        onMutationUpdate?.({
          ...mutationInfo,
          error: new Error(error),
          args,
          id,
          status: 'error',
        })
        return
      }

      const sendTx = () => {
        tx.writeContract(
          {
            abi: config.getAbi(),
            functionName: config.functionName,
            address,
            chainId: chain?.id,
            args,
            account: boundAccount,
            connector: boundConnector,
          },
          {
            onSettled(data, error) {
              const status: MutationInfo['status'] = error ? 'error' : 'signed'
              onMutationUpdate?.({
                ...mutationInfo,
                id,
                args,
                error: error ? new Error(error.message) : undefined,
                status,
                txHash: data,
              })
            },
          },
        )

        onMutationUpdate?.({
          ...mutationInfo,
          id,
          args,
          status: 'submitted',
        })
      }

      if ((options?.simulate ?? simulateMutations) && client) {
        simulate(...(args as Args))
          .then(sendTx)
          .catch((error) => {
            onMutationUpdate?.({
              ...mutationInfo,
              id,
              args,
              error: new Error(error.message),
              status: 'error',
            })
          })
      } else {
        sendTx()
      }
    },
    [address, tx, config, account, connector, chain?.id, options?.simulate, simulateMutations, client, simulate],
  )

  const confirmation = useMutationConfirmation(tx.data)
  return useMemo(
    () => ({
      status: tx.status,
      data: tx.data,
      error: tx.error,
      isPending: tx.isPending,
      isSuccess: tx.isSuccess,
      isError: tx.isError,
      isLoading: tx.isPending || confirmation.isLoading,
      failureCount: tx.failureCount,
      failureReason: tx.failureReason,
      isIdle: tx.isIdle,
      submittedAt: tx.submittedAt,
      confirmation,
      reset: tx.reset,
      send,
      simulate,
      estimate,
    }),

    [tx, send, confirmation, simulate, estimate],
  )
}

/**
 * Return type of the useMutation hook
 * Includes transaction state, confirmation status, and send function
 */
export type Mutation<M extends string, Args extends readonly any[]> = ReturnType<typeof useMutation<M, Args>>
