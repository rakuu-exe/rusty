# Rust Event Bot worker.
#
# Lives at the repo root (rather than in worker/) so Railway finds it without
# needing a Root Directory override in the dashboard.
#
# Two stages: the builder compiles TypeScript, the runtime carries only
# production dependencies plus the emitted JavaScript.

# ---- builder ---------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# scripts/ must be present before install: postinstall runs patch-proto.mjs,
# which relaxes the `required` fields in the bundled Rust+ protobuf schema.
# Without it the bot crashes the moment a server omits a field, which is not
# hypothetical -- it happened on first contact with a live server.
COPY worker/package.json worker/package-lock.json ./
COPY worker/scripts ./scripts

RUN npm ci

COPY worker/tsconfig.json worker/tsconfig.build.json ./
COPY worker/src ./src

RUN npm run build

# ---- runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY worker/package.json worker/package-lock.json ./
COPY worker/scripts ./scripts

# Production dependencies only. postinstall re-applies the protobuf patch to
# this fresh node_modules -- it must, since the builder's copy is discarded.
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Item id to name map for the vending system. Without it every item renders as
# a raw numeric id, which still works but is useless to read.
COPY data ./data

# Not a web service: no port is exposed and no HTTP server is started. It holds
# a Discord gateway connection and a Rust+ WebSocket, and that is all.
CMD ["node", "dist/index.js"]
