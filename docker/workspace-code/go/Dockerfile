FROM golang:1.24
LABEL learnharness.workspace=code
ENV HOME=/work/.home GOTOOLCHAIN=local GOPROXY=off GOFLAGS=-mod=mod CGO_ENABLED=0 \
    GOCACHE=/work/.cache/go GOPATH=/work/.cache/gopath
COPY go.mod /opt/scaffold/go.mod
RUN chmod -R a+rX /opt/scaffold
