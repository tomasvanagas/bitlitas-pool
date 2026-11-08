# Pool image on Node 22 LTS (Debian bookworm). The native hashing modules
# (cryptonight-hashing for RandomX, cryptoforknote-util, bignum) compile
# during npm install, so the build tools and Boost/OpenSSL/libsodium headers
# are installed first. The pool reads its configuration from /config.
FROM node:22-bookworm-slim

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       ca-certificates git python3 make g++ pkg-config \
       libboost-all-dev libssl-dev libsodium-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /pool/

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

RUN mkdir -p /config

EXPOSE 8117
EXPOSE 3333
EXPOSE 5555
EXPOSE 7777

VOLUME ["/config"]

CMD ["node", "init.js", "-config=/config/config.json"]
