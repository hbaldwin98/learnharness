FROM rust:1-slim
LABEL learnharness.workspace=code
ENV HOME=/work/.home CARGO_HOME=/work/.cache/cargo CARGO_TARGET_DIR=/work/.cache/target \
    PATH=/usr/local/cargo/bin:$PATH CARGO_NET_OFFLINE=true
COPY Cargo.toml /opt/scaffold/Cargo.toml
RUN chmod -R a+rX /opt/scaffold
