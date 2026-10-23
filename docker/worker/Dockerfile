# Pluton-Harness worker image (ADR-0004, ADR-0005).
#
# Minimal, non-root sandbox base for Ship containers: tmux for terminals,
# git for task checkouts, and a `sleep infinity` main process so
# `docker create` + `start` behaves like a long-lived machine.
#
# Digest pinning: pin BASE by digest for reproducible provisioning, e.g.
#   docker build --build-arg BASE=node:24-bookworm-slim@sha256:<digest> ...
# The build script records the resulting image ID; the runtime refuses to run
# a plugin image that no longer matches the recorded ID (see src/sandbox/image.ts).
#
# The OpenCode engine CLI is installed by the optional `engines` profile layer
# below (`pluton sandbox build-image --engines`), pinned to the version
# live-verified against the adapter on the development host. The base profile
# stays small and its tests stay honest about what it contains.

ARG BASE=node:24-bookworm-slim
FROM ${BASE}

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tmux \
        git \
        ca-certificates \
        procps \
        less \
    && rm -rf /var/lib/apt/lists/*

# --- engines profile (build-arg PLUTON_ENGINES=1) ---------------------------
# Pinned to the version verified against the adapter on the dev host:
#   @opencode/cli 2.0.31  (declares linux/x64 platform packages, incl. musl)
# Install + self-check run as root (global npm prefix) while the worker user
# does not exist yet: a broken platform install fails the build here, never a
# live run. `src/sandbox/image.ts` proves the binary again after the build.
ARG PLUTON_ENGINES=0
RUN if [ "$PLUTON_ENGINES" = "1" ]; then \
      npm install -g --omit=dev @opencode/cli@2.0.31 \
      && opencode --version; \
    fi

# Non-root worker user; `docker create` also passes --user 10001:10001 (ADR-0004).
RUN groupadd --gid 10001 pluton \
    && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash pluton

USER pluton
ENV HOME=/home/pluton
WORKDIR /home/pluton

# Host-created checkouts are bind-mounted in; ownership will not always map to
# uid 10001, so tell the container-side git not to reject them. The container
# is the security boundary (ADR-0004), not this setting.
RUN git config --global --add safe.directory '*' \
    && git config --global advice.detachedHead false

# Fail the build loudly if a required tool is missing — every terminal feature
# and every checkout depends on these being present.
RUN tmux -V && git --version && node --version

CMD ["sleep", "infinity"]
