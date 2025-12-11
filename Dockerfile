# Use official Cloudflare sandbox base image
FROM docker.io/cloudflare/sandbox:0.6.5

# Install system dependencies (rarely change - cached layer)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    jq \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Add opencode install location to PATH
ENV PATH="/root/.opencode/bin:${PATH}"

# Install OpenCode CLI
RUN curl -fsSL https://opencode.ai/install -o /tmp/install-opencode.sh \
    && bash /tmp/install-opencode.sh \
    && rm /tmp/install-opencode.sh \
    && opencode --version

# Install global Node.js tools (cached layer)
RUN npm install -g \
    typescript \
    tsx \
    && npm cache clean --force

# Set up git config
RUN git config --global init.defaultBranch main \
    && git config --global advice.detachedHead false

# Create workspace directory
RUN mkdir -p /home/user/workspace
WORKDIR /home/user/workspace

# Expose OpenCode server port
EXPOSE 4096

# Default command
CMD ["bash"]
