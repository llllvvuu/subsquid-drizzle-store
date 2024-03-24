# `@llllvvuu/subsquid-drizzle-store`

```sh
pnpm install @llllvvuu/subsquid-drizzle-store
```

Caveats:

- Only supports Postgres
- Does not support hot blocks

## Example

```typescript
import { DrizzleDatabase } from '@llllvvuu/subsquid-drizzle-store'
import { drizzle } from 'drizzle-orm/node-postgres'
import { numeric, pgTable, text, varchar } from 'drizzle-orm/pg-core'
import pg from 'pg'
const { Client } = pg

const client = new Client({ connectionString: process.env['DB_URL'] })
await client.connect()
export const db = drizzle(client)

export const transfer = pgTable('transfer', {
  id: varchar('id').primaryKey(),
  from: text('from').notNull(),
  to: text('to').notNull(),
  value: numeric('value').notNull(),
})

// ...

const store = new DrizzleDatabase(db)
processor.run(store, async ctx => {
  const transfers: { id: string; from: string; to: string; value: string }[] =
    []
  for (let block of ctx.blocks) {
    for (let log of block.logs) {
      let { from, to, value } = usdtAbi.events.Transfer.decode(log)
      transfers.push({
        id: log.id,
        from,
        to,
        value: String(value),
      })
    }
  }
  if (transfers.length === 0) return
  await ctx.store.insert(transfer).values(transfers)
})
```
