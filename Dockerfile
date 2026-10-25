# Overhand on a Linux server: the release binary and its app, run as a non-root user, everything it keeps on one volume.
#   docker build -t overhand .
#   docker run -d --name overhand --network host --restart unless-stopped -v overhand:/home/overhand overhand
# It listens on 127.0.0.1 only, so with --network host it's the server's own loopback: reach it over an SSH tunnel or
# tailscale serve (site/pages/docs/server.html). Never publish the port to the internet.

# the build runs on the builder's own platform and cross-compiles for the image's (bun build --compile --target)
# both bases pinned by digest (the multi-platform index), so a moved tag can't change what's built; Dependabot bumps them
FROM --platform=$BUILDPLATFORM oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7 AS build
ARG TARGETARCH
WORKDIR /src
COPY . .
RUN p="linux-$([ "$TARGETARCH" = amd64 ] && echo x64 || echo arm64)" \
  && bun install --frozen-lockfile \
  && bun release/build.ts /out "$p" \
  && mv "/out/overhand-$p" /out/pkg

FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
# source links the GHCR package to its repo; release/launch.ts, which pushes it, passes the version and the commit
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/craftly-io/overhand" \
  org.opencontainers.image.version="$VERSION" \
  org.opencontainers.image.revision="$REVISION"
# git and gh for the agents' work, curl for the agents' own installers and the healthcheck, ps for the process tree (the
# governor, the guard), tini to reap what agents leave
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git gh procps tini \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 1000 --shell /bin/bash overhand
COPY --from=build /out/pkg /opt/overhand
RUN ln -s /opt/overhand/overhand /usr/local/bin/overhand
USER overhand
WORKDIR /home/overhand
# the whole home is the volume: Overhand's state, the agents and their sign-ins, gh's login and the projects
# no keyring in a container, so API keys go to a file only this user can read
ENV OVERHAND_HOME=/home/overhand/.overhand \
  OVERHAND_SECRETS_FILE=/home/overhand/.overhand/secrets.json \
  PATH=/home/overhand/.local/bin:$PATH
VOLUME /home/overhand
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS -o /dev/null -H "x-overhand-key: $(cat "$OVERHAND_HOME/control/local-key" 2>/dev/null)" \
    "http://127.0.0.1:${OVERHAND_PORT:-4317}/api/state" || exit 1
ENTRYPOINT ["tini", "--", "overhand"]
CMD ["daemon"]
