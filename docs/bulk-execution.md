# Large Write Scripts

When you click the normal Execute button, Lagun can run large query-tab write
scripts with one backend request, one database connection, and one transaction.

Use it for batches of simple `INSERT ... VALUES`, `UPDATE ... WHERE`, and
`DELETE ... WHERE` statements. Lagun preserves statement order and rolls back
the whole transaction on the first failure.

## Copy-Paste Hello World

Create a demo table first:

```sql
CREATE DATABASE IF NOT EXISTS lagun_bulk_demo;
CREATE TABLE IF NOT EXISTS lagun_bulk_demo.bulk_demo (
  id INT PRIMARY KEY,
  name VARCHAR(80) NOT NULL
) ENGINE=InnoDB;
```

Then paste and run 25+ inserts in the query tab:

```sql
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (1, 'row 1');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (2, 'row 2');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (3, 'row 3');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (4, 'row 4');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (5, 'row 5');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (6, 'row 6');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (7, 'row 7');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (8, 'row 8');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (9, 'row 9');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (10, 'row 10');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (11, 'row 11');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (12, 'row 12');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (13, 'row 13');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (14, 'row 14');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (15, 'row 15');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (16, 'row 16');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (17, 'row 17');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (18, 'row 18');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (19, 'row 19');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (20, 'row 20');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (21, 'row 21');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (22, 'row 22');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (23, 'row 23');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (24, 'row 24');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (25, 'row 25');
```

You should see a committed write summary.

Rollback demo: paste 25+ statements where one statement violates a constraint.
For example, duplicate this block enough times to cross the threshold:

```sql
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (101, 'ok');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (102, 'ok');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (101, 'duplicate id');
INSERT INTO lagun_bulk_demo.bulk_demo (id, name) VALUES (103, 'not reached');
```

Lagun should report rollback and rows from that failed script should not commit.

## API

```http
POST /api/v1/sessions/{session_id}/query/script/validate
POST /api/v1/sessions/{session_id}/query/script
DELETE /api/v1/sessions/{session_id}/query/script/{execution_id}
```

Request:

```json
{
  "execution_id": "client-generated-id",
  "database": "optional_database",
  "sql": "INSERT INTO users (name) VALUES ('Ada');",
  "mode": "transaction"
}
```

## V1 Limits

- Default statement limit: `3000`
- One active large write script per session
- No reads, DDL, session commands, or transaction-control statements
- `UPDATE` and `DELETE` require a detectable `WHERE`
- `INSERT ... SELECT`, CTEs, subqueries, and multi-table writes are not eligible
- No MySQL multi-statements flag is enabled

Admin knobs:

- `LAGUN_BULK_WRITE_THRESHOLD` or `VITE_LAGUN_BULK_WRITE_THRESHOLD`
  (frontend build-time threshold, default `25`)
- `LAGUN_BULK_MAX_STATEMENTS`
- `LAGUN_BULK_MAX_BODY_BYTES`
- `LAGUN_BULK_MAX_STATEMENT_BYTES`
- `LAGUN_BULK_LOCK_WAIT_TIMEOUT_SECONDS`
- `LAGUN_BULK_MAX_RUNTIME_SECONDS`

## Error Shape

Large write script errors include:

```json
{
  "code": "MISSING_WHERE",
  "problem": "UPDATE statements need WHERE in large write scripts.",
  "cause": "Statement 1 has no detectable WHERE clause.",
  "fix": "Add a WHERE clause or run the statement manually.",
  "docs_url": "/docs/bulk-execution#missing-where"
}
```

The compatibility check only decides whether the script can use the large-write
backend path.
It is not semantic SQL safety proof.

## Troubleshooting

- `LOCK_WAIT_TIMEOUT`: another transaction held a row lock too long. Lagun rolls
  back the script; retry later, reduce the batch, or run during a quieter window.
- `MAX_RUNTIME_EXCEEDED`: the script exceeded `LAGUN_BULK_MAX_RUNTIME_SECONDS`.
  Split the script or raise the server-side limit.
- `OUTCOME_UNKNOWN`: the browser lost the final response. Check the target rows
  before rerunning.
- `CANCELLED_ROLLED_BACK`: Lagun sent a cancel request for the active execution.
  Check target rows before rerunning if the connection dropped during cancellation.
- `NONTRANSACTIONAL_TABLE`: the target table uses an engine such as MyISAM.
  Convert it to InnoDB if you need rollback guarantees.
