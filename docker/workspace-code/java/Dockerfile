# The language server (plan step 4): Eclipse jdtls, which needs Java 25
# to run — a 25 runtime is copied in for it alone; the learner's code
# builds, runs and is checked against the image's Java 21.
FROM eclipse-temurin:25-jre AS jre25

FROM eclipse-temurin:21-jdk
LABEL learnharness.workspace=code
ENV HOME=/work/.home
COPY --from=jre25 /opt/java/openjdk /opt/jre25
ADD https://repo1.maven.org/maven2/org/junit/platform/junit-platform-console-standalone/1.11.4/junit-platform-console-standalone-1.11.4.jar /opt/lh/junit.jar
ADD https://download.eclipse.org/jdtls/milestones/1.62.0/jdt-language-server-1.62.0-202610131109.tar.gz /tmp/jdtls.tar.gz
RUN mkdir -p /opt/jdtls /opt/scaffold && tar -xzf /tmp/jdtls.tar.gz -C /opt/jdtls && rm /tmp/jdtls.tar.gz \
 && chmod -R a+rX /opt/lh /opt/scaffold /opt/jdtls /opt/jre25
