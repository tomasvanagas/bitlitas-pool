#!/bin/sh
# -----------------------------------------------------------
#  [*] Pool — regression test runner
#
#  Builds the PRODUCTION image from this folder under a tag
#  of its own (the same Node 22, the same compiled hashing
#  modules and the same source that ship — the published
#  vuknf/bitlitas-pool image is never touched), builds the
#  test image on top of it (Dockerfile.tests: Redis and the
#  suite) and runs the suite inside a throwaway container
#  with no network and a read-only root filesystem, /tmp its
#  only writable place. A test that reaches out fails instead
#  of passing by luck, and nothing outside the container is
#  touched: the daemon, the wallet and every miner are fakes
#  inside it, and no wallet key exists anywhere. Extra
#  arguments go to node --test — a test file, a
#  --test-name-pattern; tests/README.md lists the suites and
#  the pinned defects.
# -----------------------------------------------------------
set -e
cd "$(dirname "$0")"

sudo docker build -t bitlitas-pool-check .
sudo docker build -f Dockerfile.tests -t bitlitas-pool-tests tests
sudo docker run --rm --name bitlitas-pool-tests --network none --read-only \
  --tmpfs /tmp:size=1g \
  --memory=6g --memory-swap=6g --cpus=6 \
  bitlitas-pool-tests "$@"
