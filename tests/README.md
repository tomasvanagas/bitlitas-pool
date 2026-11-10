# Pool regression tests

The regression suite of the Bitlitas mining pool (cryptonote-nodejs-pool
v2.0.0 on Node 22). It runs in one throwaway container with no network,
built from the production image. Every test file builds its own world in
that container — a redis-server, a fake bitlitasd and a fake
bitlitas-wallet-rpc answering as v0.18.3.1 does, and the pools it starts
with `node init.js` — and miners that really mine RandomX. One suite
swaps the fakes for the real bitlitasd and bitlitas-wallet-rpc v0.18.3.1
on a regtest chain of their own, still offline. It runs on
Node's built-in test runner; the hashing modules and the Redis client come
from the pool's own `node_modules`, so the suite installs nothing of its
own.

## Running

From the repository root:

```sh
./runTests.sh                                    # every suite
./runTests.sh tests/stratum                      # one folder
./runTests.sh tests/stratum/shares.test.js       # one file
./runTests.sh --test-name-pattern=ban            # tests whose name matches
```

Each run does three things:

1. Builds the production `Dockerfile` from the working tree as
   `bitlitas-pool-check`, so the suite tests what would ship. The
   published `vuknf/bitlitas-pool` image is never touched.
2. Adds `Dockerfile.tests` on top (Redis, the bitlitasd and
   bitlitas-wallet-rpc binaries of `vuknf/bitlitasd-v2:20261108`, and
   the suite) as `bitlitas-pool-tests`.
3. Starts the result with `--network none`, a read-only root filesystem
   and `/tmp` as its only writable place, 6 GB of memory and six CPUs.

Every argument goes to `node --test`; a folder stands for the test files
under it. Four files run side by side. When a test fails, the crash logs
the pools wrote are printed under the report. A whole run takes about
three minutes.

The host needs only docker. Node, Redis, the compiled hashing modules and
the Bitlitas binaries live in the image.

## Layers

| Suite | Folder | What it checks | How |
|---|---|---|---|
| Configuration | `config/` | `config_examples/bitlitas.json` against the coin: atomic units, block target, address prefixes, RPC port, unlock window, fees, the price source that leaves the pool alone | Reads the file; the constants come from the Bitlitas v0.18 source |
| Hashing | `hashing/` | RandomX and block ids against three real Monero blocks (forks 12, 14 and 16 — Bitlitas mines Monero's RandomX unchanged), seed heights, the templates bitlitasd hands out and the block the pool builds, which bitlitasd accepted | The native modules, on the fixtures |
| Units | `units/` | The modules every process shares: the configuration reader and its donations, address rules, helpers, the JSON-RPC client, the log system and crash handler, notifications by email and Telegram | Loaded in the test's own process with the shipped configuration as `config`, or in a short process of their own |
| Stratum | `stratum/` | What miners meet: the wire protocol, logins (the shipped and the upstream payment-id separator), jobs and templates (odd reserves, `alwaysPoll`), shares and blocks, bans, share trust, vardiff, the 30-second sweep of idle miners and old bans, xmr-node-proxy, fifty logins and hundreds of shares at once | The whole pool against the fake daemon, with stratum clients that mine |
| Unlocker | `unlocker/` | Maturing and orphaning blocks, splitting rewards, the fee settings, reorganisations before and after maturity | `-module=unlocker` on candidates written into Redis |
| Payments | `payments/` | Thresholds, rounding, fees, batching, integrated addresses and payment ids, a wallet that refuses or is away, limits, the ring size | `-module=payments` on balances written into Redis, against the fake wallet |
| API | `api/` | The public calls, the administration calls and their password, a miner's settings, the charts, HTTPS, the edges of every answer | `-module=api` (and `-module=chartsDataCollector`) on records written into Redis |
| Startup | `startup/` | Bad configurations, the default config path, single modules, cluster sizes, the pool server off, the SSL port and its files, dead workers, a late Redis, a Redis behind a password | `node init.js` started and watched |
| Flows | `flows/` | A block's life from a share to the payment and the API; the same against the real bitlitasd and wallet; the mail every pool event sends; a Redis that refuses writes, runs out of memory or stops | The whole pool, mining clients, the suite's mail server, the real binaries on regtest |
| Website | `website/` | Every endpoint `website_example/` calls exists and answers the call the site makes | The endpoints read out of the site's files, against `-module=api` |

## Layout

| Path | What lives there |
|---|---|
| `support/world.js` | The World: one file's folder, its claimed ports, Redis, the fakes, the sandboxed configuration and the pools it starts |
| `support/pool-process.js` | A running pool (`node init.js`), its output, its workers by type; `runNode` for short programs of their own |
| `support/daemon.js` | The fake bitlitasd, with its broken modes |
| `support/wallet.js` | The fake bitlitas-wallet-rpc, refusing what the real one refused |
| `support/chain.js` | The chain the daemon serves and the template builder held to bitlitasd's templates |
| `support/stratum.js` | The stratum client and the RandomX miner |
| `support/addresses.js` | Bitlitas addresses: the fixture wallet's real ones and a builder (Keccak-256, base58) |
| `support/rounds.js` | Found blocks, matured blocks and balances written into Redis as the pool writes them |
| `support/http.js` | The API client that never throws |
| `support/redis.js` | A redis-server of a world's own, which can turn read-only or run out of memory |
| `support/bitlitasd.js` | The real bitlitasd and bitlitas-wallet-rpc on a regtest chain of a world's own |
| `support/smtp.js` | A mail server that keeps what it gets |
| `support/defects.js` | `pinDefect`, see Rules |
| `support/wait.js` | `waitFor` and `sleep` |
| `fixtures/monero-mainnet-blocks.json` | Three Monero mainnet blocks: blob, id, difficulty, seed and RandomX hash |
| `fixtures/bitlitasd-regtest.json` | What bitlitasd and bitlitas-wallet-rpc v0.18.3.1 answered on a regtest chain: templates, headers, submissions, transfers and their errors, and the wallet's addresses |
| `container/run.sh` | The test image's entrypoint |
| `<suite>/*.test.js` | The suites; each suite's pinned defects in its `defects.test.js` |

Three files outside `tests/` belong to the suite:

- `runTests.sh` runs everything.
- `Dockerfile.tests` builds the test image; its build context is `tests/`,
  and the Bitlitas binaries come from `vuknf/bitlitasd-v2:20261108`.
- `.dockerignore` keeps the suite out of the production image.

## Rules

- **Offline.** The container has no network. The daemon, the wallet, the
  miners and the mail server are fakes inside it, or — in
  `flows/real-daemon.test.js` — the real Bitlitas binaries on a regtest
  chain nobody else can see; Telegram's sender is replaced by a recorder
  where a test needs what it would send, and only run as far as its
  checks otherwise. No wallet key outlives its container.
- **Production-shaped.**
  - The pool runs from the image's own `/pool` the way the image starts
    it, `node init.js -config=…`, its master forking its workers.
  - Its configuration is the shipped `config_examples/bitlitas.json` with
    only what a sandbox must change: a real pool wallet in place of the
    placeholder, the claimed ports, the world's log folder, and one pool
    worker in place of one per CPU. Everything a test changes beyond
    that, it states in the call that starts the pool.
  - The fakes answer in the shapes the real v0.18 daemon and wallet
    answered, captured into `fixtures/bitlitasd-regtest.json`.
- **Every file builds its own world.** Its Redis, ports and folder are
  its own, so files run side by side and a test can stop the database,
  the daemon or the wallet under the pool.
- **Real hashing.** Shares are mined with the same RandomX the pool
  checks them with, keyed by the job's seed; the fixtures tie that RandomX
  to the real network.
- **No bug is fixed from here.** A test that finds a defect does not
  change the pool. It pins the defect in its suite's `defects.test.js`
  with `pinDefect('id', 'what the pool should do', fn)`:
  - The test body asserts the wanted behaviour.
  - While the defect lives, the assertion fails, the test is reported as
    TODO with its id and the first line of the failure, and the run stays
    green. Any other error fails the test, so a pin cannot hide a broken
    test.
  - Once a fix makes the assertion pass, the test fails with "no longer
    reproduces". That failure is the cue to drop the pin and move the
    test into its home file.
- **House style.** Banners follow the house-comments skill and its
  JavaScript reference. The skill's gate reads TypeScript, so it runs on
  a copy of the suite with `.js` renamed `.ts` and the `require` lines
  written as imports; it prints `-- 0 violation(s)`.

## Pinned defects

Forty-three, each pinned by a test that reproduces it.

Stratum (`stratum/defects.test.js`):

| Id | Defect |
|---|---|
| `subaddress-refused` | The shipped file names no `subAddressPrefix`, so a Bitlitas subaddress (prefix 42) is refused at login. |
| `login-without-password-unanswered` | A login without `pass` throws in `lib/pool.js`; the request is never answered and the miner waits. |
| `standalone-payment-id-accepted` | A login with a 64-character payment id is credited, but bitlitas-wallet-rpc v0.18 refuses every standalone payment id: the balance can never be paid, and every payment run tries again. |
| `fixed-difficulty-not-capped` | A fixed difficulty is raised to `minDiff` but never capped at `maxDiff`; above 2^32 its target is `00000000`. |
| `proxy-job-missing-pool-offset` | A job for xmr-node-proxy has no `client_pool_offset` (the template never sets `clientPoolLocation`), and its shares get the pool nonce written at byte 0 of the block. |
| `template-fetch-not-retried` | When the first template fetch for a new tip fails, the poller has already stored the tip's hash and never asks again: the pool mines the stale template until the next block — which, while the pool is the network's only miner, never comes. |
| `same-height-template-keeps-old-job` | When the tip is replaced at the same height, the pool takes the new template but pushes miners the job it cached for the old one, and checks their shares against the new template, refusing all of them. |
| `daemon-hang-stalls-templates` | The JSON-RPC client has no timeout: a daemon that takes a request and never answers stops the poller for good (the API's statistics stall the same way). |
| `respawned-worker-has-no-template` | A pool worker forked again after a crash gets no template until the next block, and answers no login meanwhile. Templates go out only when the tip moves, so a pool worker still loading when the first one arrives misses it the same way. |
| `login-before-template-unanswered` | A login before the pool has its first template throws and is never answered. |
| `stale-share-against-new-template` | A share mined for the previous block's job is checked against the current template (only merged mining looks up a job's own), refused as invalid, counted toward a ban, and breaks share trust. |
| `refused-block-share-not-credited` | A share at block difficulty whose block the daemon refuses is not credited as the share it still is. |
| `solo-block-closes-shared-round` | A solo block closes the shared (prop) round under its height too; the unlocker deletes that round when the solo block matures, so the shared miners lose every share since their last block. |
| `unparsable-template-replaces-good-one` | A template the pool cannot parse becomes the current one before the pool finds out: no miner gets its job, and no login is answered until the next block. |
| `slush-mining-scores-nothing` | With slush mining on, the scoring script reads a `lastBlockFound` the pool no longer writes and fails, and writes to `scores:roundCurrent` besides — no share is scored where the unlocker pays from. |
| `proxy-share-pool-nonce-misplaced` | A share xmr-node-proxy builds at the offsets of its job is refused: the pool writes the pool nonce at byte 0 of the block, its offset never set. |
| `short-payment-id-refusal-names-undefined` | Under the "+" separator, a payment id shorter than 16 characters is refused with "undefined banned for 10 minutes": it names no IP, and claims a ban while validation is off. |

Unlocker (`unlocker/defects.test.js`):

| Id | Defect |
|---|---|
| `orphan-shares-to-unread-key` | An orphaned round's shares are given back to `bitlitas:scores:roundCurrent`, a key no round reads (the rounds are `scores:prop:` and `scores:solo:`); they are lost. |
| `empty-daemon-reply-crashes-unlocker` | A header reply with neither a result nor an error — an empty body — crashes the unlocker on `result.block_header`. |

Payments (`payments/defects.test.js`):

| Id | Defect |
|---|---|
| `payment-records-configured-fee` | A payment's records carry the configured fee (0.014 LTL per destination), not the fee the wallet paid (0.0026 LTL for one destination in the fixtures). |
| `unreadable-transfer-reply-pays-twice` | A transfer reply the run cannot read crashes it after the wallet has the transfer; the run that starts over pays the same balances again. |

The whole pool and its Redis (`flows/defects.test.js`):

| Id | Defect |
|---|---|
| `redis-stop-kills-every-worker` | No worker listens for its Redis client's errors, so a Redis that stops kills every worker, again every two seconds while it is away: miners are disconnected, the ports and the API refuse connections. When Redis is back, the pool workers forked again have no template (`respawned-worker-has-no-template`) and answer no login until the next block — which, while the pool is the network's only miner, never comes. |
| `redis-write-error-kills-worker` | A Redis that refuses writes (a read-only replica after a failover) fails the writes a login sends without a callback; their errors reach the same missing listener, and the pool worker dies after answering the login. |
| `redis-refusal-loses-block` | A block the daemon took while Redis refused writes is never recorded: its reward sits in the pool wallet and no candidate exists to credit the miners, also once Redis takes writes again. |
| `redis-refusal-pays-twice` | When Redis refuses the bookkeeping after a transfer, the balance stays as it was, and every run after pays it again — three times in three seconds here, as long as Redis refuses. |
| `api-crashes-on-failed-redis-transaction` | The API's health check reads the replies of a transaction that failed (a Redis out of memory) and crashes the API worker, again at every collection. |

API (`api/defects.test.js`):

| Id | Defect |
|---|---|
| `forwarded-for-skips-password` | With `trustProxyIP` on, as shipped, a request with `X-Forwarded-For: 127.0.0.1` is local: every administration call answers it without the password. |
| `payout-level-trusts-typed-ip` | A payout level (or a notification address) changes for whoever names an IP the miner mined from, not for requests from that IP. |
| `workers-hashrate-counts-characters` | `/workers_hashrate` counts its Content-Length in characters, so a worker name with Lithuanian letters cuts the reply short — and the charts collector loses every worker's chart. |
| `empty-password-adds-no-hashrate` | The pool's hashrate adds up worker records only, and a miner with an empty password never gets one. |
| `market-lookup-never-answers` | `/get_market` on an exchange the pool cannot reach (any visitor can name one) never answers, and the connection stays open. |
| `admin-log-refused-name-crashes` | `/admin_log` refuses a file name it does not take, then carries on and crashes the API worker. |
| `admin-log-missing-file-crashes` | `/admin_log` for a log file that does not exist crashes the API worker. |
| `blocks-chart-one-day-keys` | With `charts.blocks.days` at 1, the blocks chart has hourly buckets but counts each block under its day: the hour key is computed and dropped. |

Startup (`startup/defects.test.js`):

| Id | Defect |
|---|---|
| `placeholder-address-exits-zero` | The master refuses the placeholder pool wallet but exits with status 0, which a supervisor reads as a normal stop. |
| `undecodable-pool-address-crash-loop` | A pool wallet that does not decode passes the start check; every pool worker then crashes loading `lib/utils.js`, every two seconds. |
| `port-in-use-crash-loop` | A stratum port another program holds crashes the pool worker every two seconds: the listen callback that would log the failure never gets an error, and no one listens for the server's error event. |
| `unknown-algorithm-starts-anyway` | An algorithm the hashing module lacks is logged and the pool starts all the same; every share then throws and is never answered. |

Shared modules (`units/defects.test.js`):

| Id | Defect |
|---|---|
| `log-write-crash` | A log write that fails calls a callback the logger never defined: a full disk or a vanished log folder crashes every process at its next flush. |
| `telegram-client-gone` | `package.json` asks for node-telegram-bot-api `*`, which installs 2.x, a framework without the `TelegramBot` class: with Telegram on, every notification throws and the bot worker crashes at start. |
| `mailgun-client-gone` | `package.json` asks for mailgun.js `^3.7.3`, whose client is built with `new Mailgun(formData)`; `lib/email.js` calls the 2.x `client()` off the module, so the Mailgun transport throws in whatever sends the mail. |
| `sendmail-transport-is-smtp` | The shipped transport, `sendmail`, makes nodemailer build its SMTP transport to localhost:587; sendmail is never run. |
| `missing-email-template-crash` | A missing email template is warned about, then read anyway, and the send throws. |

## Found but not pinned

Found while writing the suite but not pinned: behaviour by design, or
nothing the shipped configuration reaches.

- **Share trust.** After `threshold` good shares (10 as shipped) a share
  is taken unchecked with a growing probability, up to 90 %: a miner can
  claim shares it never hashed until a check catches one. That is the
  trade the feature makes for CPU.
- **Bans.** One malformed or repeated nonce bans the IP at once, with
  every miner behind it. The percentage of invalid shares is measured
  against the valid ones.
- **Miner ids.** The miner id is the only proof of a session: a request
  carrying another miner's id is served as that miner — a malformed nonce
  sent with it bans the other miner's IP.
- **Bursts.** A read of more than 10 KB closes the connection even when it
  holds whole lines.
- **Telegram chats** link to any known miner without an IP check (inert
  while Telegram is off).
- **A quiet miner's chart** never records its zero: the collector reads
  the error argument of a callback as its keys, and the store skips zero
  values anyway.
- **Developer donations** of several blocks unlocked in one pass overwrite
  one another. Bitlitas has no entry in `lib/configReader.js`'s donation
  addresses, so `devDonation` never applies.
- **Dependencies.** `package.json` floats bufferutil, cli-color, time-ago,
  utf-8-validate and nodemailer-sendmail-transport at `*` too, so the next
  build can bring other versions, as it did for node-telegram-bot-api.
- **`clusterForks: "auto"`** starts one pool worker per CPU the container
  sees (24 on this host), each building its own 256 MiB RandomX cache
  with its first share.
- **The payments' `mixin`** is a field the v0.18 wallet RPC no longer
  reads; the wallet picks the ring size its hard fork requires.
- **The log** says "Miner difficulty fixed to …" for every login.
- **Hashrate records** are named by miner and millisecond, so two shares
  of one miner recorded in the same millisecond leave one record and the
  hashrate falls short. Recording a share takes about a millisecond, so no
  test brings two into one reliably.
- **A share Redis refuses to record** is answered as accepted and lost
  (`flows/redis-failures.test.js`); the pool cannot tell the miner later.
- **A Redis password the configuration lacks** stops the pool at the Redis
  client's ready check: it prints one NOAUTH error and starts nothing,
  for good.
- **A reorganisation deeper than 60 blocks** takes back a block the
  unlocker already credited, and nothing notices: matured blocks are never
  checked again, and their balances are paid
  (`unlocker/unlocker.test.js`). Sixty blocks is the coinbase unlock
  window, so the network's own rules end there too.

## Practical notes

Things the suite learned the hard way:

- **RandomX is slow here.** The hashing module builds the RandomX VM
  interpreted and in light mode: about 1.4 seconds a hash, and 3 seconds
  more for each new seed in each process. That holds for the pool too —
  every checked share stops its worker's event loop that long, which
  share trust is there to soften. So tests mine on a seventh port of
  difficulty 1 (`cheapPort`), where one hash is a share, and send
  hand-made results where a share is meant to be wrong. The vardiff tests
  use share trust to send bursts without hashing.
- **Blocks at a chosen height.** A test that needs a block marks a height
  in `chain.easyHeights`: the template there asks for difficulty 1, every
  other stays hard. Turning the difficulty down and up again races the
  poller, which may fetch the next template in between.
- **Jobs arrive late.** After a block the pool may still push a job for
  the template before. `jobAtHeight` waits past those.
- **Redis after the reply.** The pool answers a login or a share first and
  writes Redis after, so tests read Redis with `waitFor`.
- **Bans from their own addresses.** A ban lasts ten minutes, so tests that
  bring one connect from addresses of their own, 127.0.0.5 to 127.0.0.18;
  every 127.x address is loopback. The API's password check likewise needs a request from
  127.0.0.2, since 127.0.0.1 counts as local.
- **Ports** are claimed with an atomic `mkdir` under
  `/tmp/bitlitas-pool-tests/ports`, so files running side by side never
  take the same one. Before a pool starts, the World checks that the ports
  it will bind are free and names the process holding one that is not —
  a pool a failed test left running, which would otherwise surface as a
  worker crashing on EADDRINUSE in the next test. The startup tests,
  which start pool after pool in one world, stop them after every test,
  failed or not.
- **Exact targets.** A job's target is compared with `targetHex`, the
  pool's own arithmetic; turning a target back into a difficulty rounds.
- **The read-only image.** The pool writes nothing outside the world's
  folders. A startup test relies on the read-only root to show that the
  shipped `logs` folder, relative to the working directory, needs a
  writable volume.
- **The fixtures.** The Monero blocks are the replies of two public nodes,
  which agreed byte for byte. The Bitlitas replies came from the
  `vuknf/bitlitasd-v2:20261108` image (bitlitasd and
  bitlitas-wallet-rpc v0.18.3.1) in a throwaway container without network,
  on `--regtest --offline --fixed-difficulty 1`; the wallet RPC needs
  `--allow-mismatched-daemon-version` to follow a regtest chain, whose
  first block is already at fork 16.
- **The real daemon.** `flows/real-daemon.test.js` runs the binaries the
  test image copies from `vuknf/bitlitasd-v2:20261108`. A regtest chain
  keeps mainnet's address prefixes and is at fork 16 from its first block,
  so the wallet RPC follows it only with `--allow-mismatched-daemon-version`;
  a new wallet starts scanning near mainnet's height, so the test refreshes
  it from height 0; and a transaction's ring needs decoys, which the
  daemon mines first. The image's root is read-only, so the wallet's ring
  database lives in the world's folder.
- **Two ways for Redis to refuse.** A Redis out of memory refuses every
  transaction, reads included, since it queues nothing once full; a Redis
  turned read-only replica — `refuseWrites` makes it one of a master that
  does not exist — refuses writes but serves reads. The pool meets each in
  production, and each fails a different part of it. A Redis client
  connecting to such a replica never becomes ready, its master never
  being up, so a test that refuses writes starts its pool first.
- **The 30-second sweep** of idle miners and old bans is fixed in
  `lib/pool.js`; the tests that need it set the timeouts to seconds and
  wait for one sweep.
