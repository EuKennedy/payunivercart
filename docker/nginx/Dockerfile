# syntax=docker/dockerfile:1.7
#
# Custom nginx image with our reverse-proxy config baked in.
#
# Bind-mounting `./docker/nginx/default.conf` from the host doesn't work
# under Coolify because the orchestrator only persists `docker-compose.yml`
# at `/data/coolify/applications/<uuid>/` — the rest of the repo is only
# present in the ephemeral `/artifacts/<deploy-id>/` build directory. The
# mount target ends up resolving to a non-existent path and Docker auto-
# creates a directory in its place, then refuses to bind a file into a
# directory.
#
# Building the config into the image side-steps the whole problem.
FROM nginx:1.27-alpine

COPY default.conf /etc/nginx/conf.d/default.conf
