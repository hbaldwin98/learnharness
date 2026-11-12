FROM rust:1-slim
LABEL learnharness.workspace=code
# The language server (plan step 4): rust-analyzer with the std sources.
RUN rustup component add rust-analyzer rust-src
ENV HOME=/work/.home CARGO_HOME=/work/.cache/cargo CARGO_TARGET_DIR=/work/.cache/target \
    PATH=/usr/local/cargo/bin:$PATH CARGO_NET_OFFLINE=true
COPY Cargo.toml /opt/scaffold/Cargo.toml
RUN chmod -R a+rX /opt/scaffold
