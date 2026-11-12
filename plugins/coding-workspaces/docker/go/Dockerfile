FROM golang:1.24
LABEL learnharness.workspace=code
# The language server (plan step 4): gopls 0.20, the newest that builds
# with Go 1.24. Fetched at image build only; runs stay offline.
RUN GOTOOLCHAIN=local GOPROXY=https://proxy.golang.org GOFLAGS= GOCACHE=/tmp/gocache GOPATH=/tmp/gopath \
    go install golang.org/x/tools/gopls@v0.20.0 \
 && mv /tmp/gopath/bin/gopls /usr/local/bin/gopls && rm -rf /tmp/gocache /tmp/gopath
ENV HOME=/work/.home GOTOOLCHAIN=local GOPROXY=off GOFLAGS=-mod=mod CGO_ENABLED=0 \
    GOCACHE=/work/.cache/go GOPATH=/work/.cache/gopath
COPY go.mod /opt/scaffold/go.mod
RUN chmod -R a+rX /opt/scaffold
