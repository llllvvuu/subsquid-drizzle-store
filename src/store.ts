/**
 * Implementation adapted from:
 * https://github.com/subsquid/squid-sdk/blob/master/typeorm/typeorm-store/src/database.ts
 */

import assert from 'assert'
import { sql, type ExtractTablesWithRelations } from 'drizzle-orm'
import type {
  NodePgDatabase,
  NodePgQueryResultHKT,
} from 'drizzle-orm/node-postgres'
import type { PgTransaction } from 'drizzle-orm/pg-core'
import promiseRetry from 'promise-retry'

type PgTx = PgTransaction<
  NodePgQueryResultHKT,
  Record<string, never>,
  ExtractTablesWithRelations<Record<string, never>>
>

type IsolationLevel =
  | 'read uncommitted'
  | 'read committed'
  | 'repeatable read'
  | 'serializable'

export interface DrizzleDatabaseOptions {
  // supportHotBlocks?: boolean;
  isolationLevel?: IsolationLevel
  stateSchema?: string
}

interface FinalTxInfo {
  prevHead: HashAndHeight
  nextHead: HashAndHeight
  isOnTop: boolean
}

export interface HotTxInfo {
  finalizedHead: HashAndHeight
  baseHead: HashAndHeight
  newBlocks: HashAndHeight[]
}

interface HashAndHeight {
  height: number
  hash: string
}

interface DatabaseState extends HashAndHeight {
  top: HashAndHeight[]
  nonce: number
}

const RACE_MSG =
  'status table was updated by foreign process, make sure no other processor is running'

export class DrizzleDatabase /* implements HotDatabase<S> */ {
  private statusSchema: string
  private isolationLevel?: IsolationLevel
  public readonly supportsHotBlocks = false

  /** @param db - from `const db = drizzle(client)`. Must already be connected. */
  constructor(
    private db: NodePgDatabase,
    options?: DrizzleDatabaseOptions,
  ) {
    this.statusSchema = options?.stateSchema ?? 'squid_processor'
    const { isolationLevel } = options ?? {}
    if (isolationLevel) {
      this.isolationLevel = isolationLevel
    }
    // this.supportsHotBlocks = options?.supportHotBlocks !== false;
  }

  async connect(): Promise<DatabaseState> {
    return await this.db.transaction(async tx => {
      const schema = sql.raw(this.statusSchema) // TODO: escape?
      await tx.execute(sql`CREATE SCHEMA IF NOT EXISTS ${schema}`)
      await tx.execute(sql`
        CREATE TABLE IF NOT EXISTS ${schema}.status (
          id int4 primary key,
          height int4 not null,
          hash text DEFAULT '0x',
          nonce int4 DEFAULT 0
        )`)
      await tx.execute(
        sql`CREATE TABLE IF NOT EXISTS ${schema}.hot_block (height int4 primary key, hash text not null)`,
      )
      await tx.execute(sql`
        CREATE TABLE IF NOT EXISTS ${schema}.hot_change_log (
          block_height int4 not null references ${schema}.hot_block on delete cascade,
          index int4 not null,
          change jsonb not null,
          PRIMARY KEY (block_height, index)
        )`)
      const status = await tx
        .select({
          height: sql<number>`height`,
          hash: sql<string>`hash`,
          nonce: sql<number>`nonce`,
        })
        .from(sql`${schema}.status`)
        .where(sql`id = 0`)
      if (status.length == 0) {
        await tx.execute(
          sql`INSERT INTO ${schema}.status (id, height, hash) VALUES (0, -1, '0x')`,
        )
        status.push({ height: -1, hash: '0x', nonce: 0 })
      }
      const top: HashAndHeight[] = await tx
        .select({
          height: sql<number>`height`,
          hash: sql<string>`hash`,
        })
        .from(sql`${schema}.hot_block`)
        .orderBy(sql`height`)

      return assertStateInvariants({
        ...(status[0] as (typeof status)[number]),
        top,
      })
    })
  }

  private async getState(tx: PgTx): Promise<DatabaseState> {
    const schema = sql.raw(this.statusSchema)
    const status = await tx
      .select({
        height: sql<number>`height`,
        hash: sql<string>`hash`,
        nonce: sql<number>`nonce`,
      })
      .from(sql`${schema}.status`)
      .where(sql`id = 0`)
    assert(status.length === 1)
    const top = await tx
      .select({
        height: sql<number>`height`,
        hash: sql<string>`hash`,
      })
      .from(sql`${schema}.hot_block`)
      .orderBy(sql`height`)
    return assertStateInvariants({
      ...(status[0] as (typeof status)[number]),
      top,
    })
  }

  async transact(info: FinalTxInfo, cb: (store: PgTx) => Promise<void>) {
    await promiseRetry(async (_retry, _number) => {
      await this.db.transaction(
        async tx => {
          const state = await this.getState(tx)
          let { prevHead: prev, nextHead: next } = info

          assert(state.hash === info.prevHead.hash, RACE_MSG)
          assert(state.height === prev.height)
          assert(prev.height < next.height)
          assert(prev.hash != next.hash)

          // for (let i = state.top.length - 1; i >= 0; i--) {
          //   await rollbackBlock(this.statusSchema, tx, state.top[i]!.height);
          // }

          await cb(tx)
          await this.updateStatus(tx, state.nonce, next)
        },
        this.isolationLevel
          ? { isolationLevel: this.isolationLevel }
          : undefined,
      )
    })
  }

  // async transactHot(
  //   info: HotTxInfo,
  //   cb: (store: PgTx, block: HashAndHeight) => Promise<void>,
  // ) {
  //   return this.transactHot2(info, async (store, sliceBeg, sliceEnd) => {
  //     for (let i = sliceBeg; i < sliceEnd; i++) {
  //       const newBlock = info.newBlocks[i];
  //       assert(newBlock != null);
  //       await cb(store, newBlock);
  //     }
  //   });
  // }
  //
  // async transactHot2(
  //   info: HotTxInfo,
  //   cb: (store: PgTx, sliceBeg: number, sliceEnd: number) => Promise<void>,
  // ) {
  //   await promiseRetry(async (_retry, _number) => {
  //     await this.db.transaction(
  //       async (tx) => {
  //         const state = await this.getState(tx);
  //         let chain = [state, ...state.top];
  //
  //         assertChainContinuity(info.baseHead, info.newBlocks);
  //         assert(
  //           info.finalizedHead.height <=
  //             (info.newBlocks[info.newBlocks.length - 1] ?? info.baseHead)
  //               .height,
  //         );
  //         assert(
  //           chain.find((b) => b.hash === info.baseHead.hash),
  //           RACE_MSG,
  //         );
  //         if (info.newBlocks.length == 0) {
  //           assert(
  //             chain[chain.length - 1]?.hash === info.baseHead.hash,
  //             RACE_MSG,
  //           );
  //         }
  //         assert(chain[0]!.height <= info.finalizedHead.height, RACE_MSG);
  //
  //         const rollbackPos = info.baseHead.height + 1 - chain[0]!.height;
  //         assert(rollbackPos >= 0);
  //         for (let i = chain.length - 1; i >= rollbackPos; i--) {
  //           await rollbackBlock(this.statusSchema, tx, chain[i]!.height);
  //         }
  //         if (info.newBlocks.length) {
  //           let finalizedEnd =
  //             info.finalizedHead.height - info.newBlocks[0]!.height + 1;
  //           if (finalizedEnd > 0) {
  //             await cb(tx, 0, finalizedEnd);
  //           } else {
  //             finalizedEnd = 0;
  //           }
  //           for (let i = finalizedEnd; i < info.newBlocks.length; i++) {
  //             const b = info.newBlocks[i]!;
  //             await this.insertHotBlock(tx, b);
  //             await cb(tx, i, i + 1);
  //           }
  //         }
  //         chain = chain.slice(0, rollbackPos).concat(info.newBlocks);
  //         assert(chain.length > 0);
  //         const finalizedHeadPos = info.finalizedHead.height - chain[0]!.height;
  //         assert(chain[finalizedHeadPos]?.hash === info.finalizedHead.hash);
  //         await this.deleteHotBlocks(tx, info.finalizedHead.height);
  //         await this.updateStatus(tx, state.nonce, info.finalizedHead);
  //
  //         // TODO
  //       },
  //       this.isolationLevel
  //         ? { isolationLevel: this.isolationLevel }
  //         : undefined,
  //     );
  //   });
  // }

  private async updateStatus(
    tx: PgTx,
    nonce: number,
    next: HashAndHeight,
  ): Promise<void> {
    const schema = sql.raw(this.statusSchema)

    await tx.execute(sql`
      UPDATE ${schema}.status
      SET height = ${next.height}, hash = ${next.hash}, nonce = nonce + 1
      WHERE id = 0 AND nonce = ${nonce}
    `) // TODO: any way for DrizzleORM to return # of rows updated?
  }

  // private async insertHotBlock(tx: PgTx, block: HashAndHeight) {
  //   await tx.execute(sql`
  //     INSERT INTO ${this.statusSchema}.hot_block (height, hash)
  //     VALUES (${block.height}, ${block.hash})
  //   `);
  // }
  //
  // private async deleteHotBlocks(
  //   tx: PgTx,
  //   finalizedHeight: number,
  // ) {
  //   await tx.execute(
  //     sql`DELETE FROM ${this.statusSchema}.hot_block WHERE height <= ${finalizedHeight}`
  //   );
  // }
}

// async function rollbackBlock(
//   statusSchema: string,
//   tx: PgTx,
//   blockHeight: number,
// ) {
//   // TODO
// }

function assertStateInvariants(state: DatabaseState): DatabaseState {
  assert(Number.isSafeInteger(state.height))
  assertChainContinuity(state, state.top)
  return state
}

function assertChainContinuity(base: HashAndHeight, chain: HashAndHeight[]) {
  let prev = base
  for (const b of chain) {
    assert(b.height === prev.height + 1, 'blocks must form a continuous chain')
    prev = b
  }
}
