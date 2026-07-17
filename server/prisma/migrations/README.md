# Migrations

Production is managed by **Prisma Migrate**. Do not run `prisma db push`
against it.

## Why

The deploy used to run:

    npx prisma db push --accept-data-loss && npm start

on **every** deploy. `db push` diffs the entire schema against the live
database and reshapes it to match; `--accept-data-loss` means it does
that **without prompting**. So any disagreement between `schema.prisma`
and the live DB — a renamed field, a removed model, a half-finished
edit someone pushed — silently dropped real columns or tables from a
database holding ~1,700 players' saves. No history, no confirmation,
no undo.

It is now:

    npx prisma migrate deploy && npm start

`migrate deploy` only applies migration files that are committed to this
directory and not yet recorded in `_prisma_migrations`. It never
invents a destructive change on its own — if something is wrong, the
deploy fails instead of the data disappearing. Failing a deploy is
recoverable; dropping a column is not.

## Baseline

`0_init` is a **baseline**. It describes the schema as it already
existed in production, and was marked applied with:

    npx prisma migrate resolve --applied 0_init

It was generated from the live database only after verifying the DB and
`schema.prisma` agreed exactly (`migrate diff` produced an empty
migration, and the baseline's 19 CREATE TABLEs matched the 19 live
tables one-for-one). It is **not** meant to be run against an existing
database, and never will be — it is recorded as applied.

## Changing the schema

1. Edit `prisma/schema.prisma`.
2. `npm run db:migrate` — creates a migration file locally and applies
   it to your dev DB.
3. Review the generated SQL. If it contains a `DROP`, be certain.
4. Commit the migration directory alongside the schema change.
5. Deploy. `migrate deploy` applies it.

`npm run db:push` is deliberately wired to refuse. If you genuinely need
it (a throwaway local DB), use `npm run db:push:force`, and never point
it at production.

## Notes

* Doc comments in `schema.prisma` use `///`, not `/** */`. The latter is
  not valid Prisma and breaks `prisma generate` — which fails the build,
  since the build runs `prisma generate`.
* `npm run db:status` shows whether prod has pending migrations.
