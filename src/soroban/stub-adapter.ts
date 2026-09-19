import { SorobanAdapter, RecordReceiptParams, SyncDealStatusParams, TenantReputationRecord, MoneyContractType, OnChainPosition } from './adapter.js'
import { SorobanConfig } from './client.js'
import { RawReceiptEvent } from '../indexer/event-parser.js'
import { logger } from '../utils/logger.js'


export class StubSorobanAdapter implements SorobanAdapter {
     private static stubBalances = new Map<string, bigint>()
     private static stubBonds = new Map<string, bigint>()
     private static stubReputations = new Map<string, TenantReputationRecord>()
     private config: SorobanConfig

     constructor(config: SorobanConfig) {
          this.config = config
          logger.info('Soroban adapter: stub')
          logger.debug('Soroban stub config', { rpcUrl: config.rpcUrl })
          if (config.contractId) {
               logger.debug('Soroban stub config', { contractId: config.contractId })
          }
     }

     /**
      * Resets all stub state including balances for all instances.
      */
     public static _testOnlyReset(): void {
          this.stubBalances.clear()
          this.stubBonds.clear()
          this.stubReputations.clear()
          logger.debug('Soroban stub: static reset complete (balances, bonds, and reputations cleared)')
     }

     /**
      * Resets instance-specific state and global stub balances.
      */
     public _testOnlyReset(): void {
          this._ledger = 1000
          StubSorobanAdapter._testOnlyReset()
          logger.debug('Soroban stub: instance reset complete')
     }

     async getBalance(account: string): Promise<bigint> {
          if (!StubSorobanAdapter.stubBalances.has(account)) {
               const hash = this.simpleHash(account)
               const balance = BigInt(1000 + (hash % 9000))
               StubSorobanAdapter.stubBalances.set(account, balance)
          }
          const balance = StubSorobanAdapter.stubBalances.get(account)!
          logger.debug('Soroban stub: getBalance', { account, balance: balance.toString() })
          return balance
     }

     async credit(account: string, amount: bigint): Promise<void> {
          const currentBalance = await this.getBalance(account)
          const newBalance = currentBalance + amount
          StubSorobanAdapter.stubBalances.set(account, newBalance)
          logger.debug('Soroban stub: credit', {
               account,
               amount: amount.toString(),
               newBalance: newBalance.toString(),
          })
     }

     async debit(account: string, amount: bigint): Promise<void> {
          const currentBalance = await this.getBalance(account)
          if (currentBalance < amount) {
               throw new Error(`Insufficient balance: ${currentBalance.toString()} < ${amount.toString()}`)
          }
          const newBalance = currentBalance - amount
          StubSorobanAdapter.stubBalances.set(account, newBalance)
          logger.debug('Soroban stub: debit', {
               account,
               amount: amount.toString(),
               newBalance: newBalance.toString(),
          })
     }

     async getStakedBalance(account: string): Promise<bigint> {
          const hash = this.simpleHash(`staked:${this.config.contractId ?? 'stub'}:${account}`)
          const staked = BigInt(hash % 5_000) * 1_000_000n
          logger.debug('Soroban stub: getStakedBalance', { account, staked: staked.toString() })
          return staked
     }

     async getClaimableRewards(account: string): Promise<bigint> {
          const hash = this.simpleHash(`claimable:${this.config.contractId ?? 'stub'}:${account}`)
          const claimable = BigInt(hash % 250) * 1_000_000n
          logger.debug('Soroban stub: getClaimableRewards', { account, claimable: claimable.toString() })
          return claimable
     }

     /**
      * Stub recordReceipt: logs the call but performs no on-chain work.
      *
      * The real on-chain `record_receipt` invocation lives in
      * `RealSorobanAdapter.recordReceipt` (real-adapter.ts), which is selected
      * when SOROBAN_ADAPTER_MODE=real (see `createSorobanAdapter` in index.ts).
      *
      * This stub is intentionally inert so local development and unit tests
      * never make network calls or require admin signing keys.
      */
     async recordReceipt(params: RecordReceiptParams): Promise<void> {
          logger.info('Soroban stub: recordReceipt', {
               txId: params.txId,
               txType: params.txType,
               amountUsdc: params.amountUsdc,
               dealId: params.dealId,
          })
     }

     getConfig(): SorobanConfig {
          return { ...this.config }
     }

     private simpleHash(str: string): number {
          let hash = 0
          if (this.config.seed !== undefined) {
               const seedStr = typeof this.config.seed === 'number' ? this.config.seed.toString() : this.config.seed
               for (let i = 0; i < seedStr.length; i++) {
                    const char = seedStr.charCodeAt(i)
                    hash = ((hash << 5) - hash) + char
                    hash = hash & hash
               }
          }
          for (let i = 0; i < str.length; i++) {
               const char = str.charCodeAt(i)
               hash = ((hash << 5) - hash) + char
               hash = hash & hash
          }
          return Math.abs(hash)
     }

     private _ledger = 1000
     async getReceiptEvents(fromLedger: number | null): Promise<RawReceiptEvent[]> {
          const ledger = (fromLedger ?? this._ledger) + 1
          this._ledger = ledger
          return [{
               ledger, txHash: `stub_${ledger}`, contractId: this.config.contractId ?? 'stub',
               data: {
                    tx_id: `txid_${ledger}`, tx_type: 'PAYMENT', deal_id: `deal_${ledger % 5}`,
                    amount_usdc: '10000000', external_ref: `txid_${ledger}` // Contract stores as 'external_ref' (same as tx_id)
               }
          }]
     }

     async getTimelockEvents(fromLedger: number | null): Promise<any[]> {
          const ledger = (fromLedger ?? this._ledger) + 1
          this._ledger = ledger
          // Only emit an event occasionally to simulate a realistic queue
          if (ledger % 10 !== 0) return []
          
          return [{
               ledger, 
               txHash: `tx_${ledger}`, 
               contractId: this.config.contractId ?? 'stub_timelock',
               topic: ['governance', 'queued'],
               data: [
                    `hash_${ledger}`, // tx_hash_n
                    'StakingPool',
                    'pause',
                    [],
                    Math.floor(Date.now() / 1000) + 3600 // eta
               ]
          }]
     }

     async executeTimelock(txHash: string, target: string, functionName: string, args: any[], eta: number): Promise<string> {
    logger.info('Soroban stub: executeTimelock', { txHash, target, functionName, args, eta })
    return `stub_stellar_tx_hash_execute_${txHash}`
  }

  async cancelTimelock(txHash: string): Promise<string> {
    logger.info('Soroban stub: cancelTimelock', { txHash })
    return `stub_stellar_tx_hash_cancel_${txHash}`
  }

  async stakeBond(inspectorId: string, amount: bigint): Promise<void> {
       StubSorobanAdapter.stubBonds.set(inspectorId, amount)
       logger.debug('Soroban stub: stakeBond', { inspectorId, amount: amount.toString() })
  }

  async unstakeBond(inspectorId: string): Promise<void> {
       StubSorobanAdapter.stubBonds.delete(inspectorId)
       logger.debug('Soroban stub: unstakeBond', { inspectorId })
  }

  async isBonded(inspectorId: string): Promise<boolean> {
       const bonded = StubSorobanAdapter.stubBonds.has(inspectorId)
       logger.debug('Soroban stub: isBonded', { inspectorId, bonded })
       return bonded
  }

  async getBond(inspectorId: string): Promise<{ isBonded: boolean; amount: bigint }> {
       const amount = StubSorobanAdapter.stubBonds.get(inspectorId) ?? 0n
       const bonded = StubSorobanAdapter.stubBonds.has(inspectorId)
       logger.debug('Soroban stub: getBond', { inspectorId, bonded, amount: amount.toString() })
       return { isBonded: bonded, amount }
  }

  // Admin operations (stub implementations)
     async pause(contractId: string): Promise<string> {
          logger.info('Soroban stub: pause', { contractId })
          return 'stub_tx_hash_pause'
     }

     async unpause(contractId: string): Promise<string> {
          logger.info('Soroban stub: unpause', { contractId })
          return 'stub_tx_hash_unpause'
     }

     async setOperator(contractId: string, operatorAddress: string | null): Promise<string> {
          logger.info('Soroban stub: setOperator', { contractId, operatorAddress })
          return 'stub_tx_hash_set_operator'
     }

     async init(contractId: string, adminAddress: string, operatorAddress?: string): Promise<string> {
          logger.info('Soroban stub: init', { contractId, adminAddress, operatorAddress })
          return 'stub_tx_hash_init'
     }

     async syncDealStatus(params: SyncDealStatusParams): Promise<void> {
          logger.info('Soroban stub: syncDealStatus', { ...params })
     }

     async updateTenantReputation(tenantId: string, record: TenantReputationRecord): Promise<void> {
          const updated: TenantReputationRecord = {
               ...record,
               lastUpdated: BigInt(Math.floor(Date.now() / 1000)),
          }
          StubSorobanAdapter.stubReputations.set(tenantId, updated)
          logger.info('Soroban stub: updateTenantReputation', { tenantId, compositeScore: record.compositeScore })
     }

     async getTenantReputation(tenantId: string): Promise<TenantReputationRecord | null> {
          const record = StubSorobanAdapter.stubReputations.get(tenantId) ?? null
          logger.debug('Soroban stub: getTenantReputation', { tenantId, found: record !== null })
          return record
     }

     /**
      * Stub implementation of getOnChainPosition for testing.
      * Returns deterministic on-chain positions based on contract type and account.
      */
     async getOnChainPosition(contractType: MoneyContractType, account?: string): Promise<OnChainPosition> {
          const timestamp = BigInt(Math.floor(Date.now() / 1000))
          let contractId = ''
          let balanceMinor = 0n

          switch (contractType) {
               case 'deal_escrow':
                    contractId = this.config.dealEscrowId ?? 'stub_deal_escrow'
                    if (account) {
                         const hash = this.simpleHash(`deal_escrow:${account}`)
                         balanceMinor = BigInt(hash % 10_000) * 1_000_000n // 0-10k USDC
                    } else {
                         // Aggregate not yet implemented in stub
                         balanceMinor = 1_000_000_000n // 1000 USDC default
                    }
                    break

               case 'staking_pool':
                    contractId = this.config.stakingPoolId ?? 'stub_staking_pool'
                    if (account) {
                         balanceMinor = await this.getStakedBalance(account)
                    } else {
                         balanceMinor = 5_000_000_000n // 5000 USDC default aggregate
                    }
                    break

               case 'rent_wallet':
                    contractId = this.config.contractId ?? 'stub_rent_wallet'
                    if (account) {
                         balanceMinor = await this.getBalance(account)
                    } else {
                         balanceMinor = 2_000_000_000n // 2000 USDC default aggregate
                    }
                    break

               case 'bond_collateral':
                    contractId = this.config.inspectorBondId ?? 'stub_bond_collateral'
                    if (account) {
                         const bondInfo = await this.getBond(account)
                         balanceMinor = bondInfo.amount
                    } else {
                         balanceMinor = 500_000_000n // 500 USDC default aggregate
                    }
                    break

               default:
                    throw new Error(`Unknown contract type: ${contractType}`)
          }

          logger.debug('Soroban stub: getOnChainPosition', {
               contractType,
               account,
               contractId,
               balanceMinor: balanceMinor.toString(),
          })

          return {
               contractType,
               contractId,
               account,
               balanceMinor,
               currency: 'USDC',
               timestamp,
          }
     }
}
