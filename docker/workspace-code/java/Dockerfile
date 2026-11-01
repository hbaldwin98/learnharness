FROM eclipse-temurin:21-jdk
LABEL learnharness.workspace=code
ENV HOME=/work/.home
ADD https://repo1.maven.org/maven2/org/junit/platform/junit-platform-console-standalone/1.11.4/junit-platform-console-standalone-1.11.4.jar /opt/lh/junit.jar
RUN mkdir -p /opt/scaffold && chmod -R a+rX /opt/lh /opt/scaffold
