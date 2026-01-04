#!/bin/bash
# MidTerm macOS/Linux Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/AiTlbx/MidTerm/main/install.sh | bash

set -e

# When piped to bash, $0 is "bash" not the script path.
# Save script to temp file and re-exec so sudo re-exec works.
SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
if [[ "$SCRIPT_PATH" == "bash" || "$SCRIPT_PATH" == "/bin/bash" || "$SCRIPT_PATH" == "/usr/bin/bash" ]]; then
    TEMP_SCRIPT=$(mktemp)
    # Script is being piped - we need to download it to a file
    curl -fsSL "https://raw.githubusercontent.com/AiTlbx/MidTerm/main/install.sh" > "$TEMP_SCRIPT"
    chmod +x "$TEMP_SCRIPT"
    exec "$TEMP_SCRIPT" "$@"
fi

REPO_OWNER="AiTlbx"
REPO_NAME="MidTerm"
SERVICE_NAME="MidTerm"
LAUNCHD_LABEL="com.aitlbx.MidTerm"
# Legacy service names for migration
OLD_HOST_SERVICE_NAME="MidTerm-host"
OLD_LAUNCHD_HOST_LABEL="com.aitlbx.MidTerm-host"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m' # No Color

# Variables passed through sudo
INSTALLING_USER="${INSTALLING_USER:-}"
INSTALLING_UID="${INSTALLING_UID:-}"
INSTALLING_GID="${INSTALLING_GID:-}"
PASSWORD_HASH="${PASSWORD_HASH:-}"
PORT="${PORT:-2000}"
BIND_ADDRESS="${BIND_ADDRESS:-0.0.0.0}"

print_header() {
    echo ""
    echo -e "${CYAN}  MidTerm Installer${NC}"
    echo -e "${CYAN}  ========================${NC}"
    echo ""
}

detect_platform() {
    OS=$(uname -s)
    ARCH=$(uname -m)

    case "$OS" in
        Darwin)
            PLATFORM="osx"
            ;;
        Linux)
            PLATFORM="linux"
            ;;
        *)
            echo -e "${RED}Unsupported OS: $OS${NC}"
            exit 1
            ;;
    esac

    case "$ARCH" in
        x86_64|amd64)
            ARCH="x64"
            ;;
        arm64|aarch64)
            ARCH="arm64"
            ;;
        *)
            echo -e "${RED}Unsupported architecture: $ARCH${NC}"
            exit 1
            ;;
    esac

    # Linux only supports x64 for now
    if [ "$PLATFORM" = "linux" ] && [ "$ARCH" = "arm64" ]; then
        echo -e "${RED}Linux ARM64 is not yet supported. Using x64.${NC}"
        ARCH="x64"
    fi

    ASSET_NAME="mt-${PLATFORM}-${ARCH}.tar.gz"
    echo -e "${GRAY}Detected: $OS $ARCH${NC}"
}

get_latest_release() {
    echo -e "${GRAY}Fetching latest release...${NC}"
    RELEASE_INFO=$(curl -fsSL "https://api.github.com/repos/$REPO_OWNER/$REPO_NAME/releases/latest")
    VERSION=$(echo "$RELEASE_INFO" | grep '"tag_name"' | sed -E 's/.*"tag_name": *"v?([^"]+)".*/\1/')
    ASSET_URL=$(echo "$RELEASE_INFO" | grep "browser_download_url.*$ASSET_NAME" | sed -E 's/.*"browser_download_url": *"([^"]+)".*/\1/')

    if [ -z "$ASSET_URL" ]; then
        echo -e "${RED}Could not find $ASSET_NAME in release assets${NC}"
        exit 1
    fi

    echo -e "  Latest version: ${CYAN}$VERSION${NC}"
    echo ""
}

prompt_service_mode() {
    echo -e "  ${CYAN}How would you like to install MidTerm?${NC}"
    echo ""
    echo -e "  ${CYAN}[1] System service${NC} (recommended for always-on access)"
    echo -e "      ${GRAY}- Runs in background, starts on boot${NC}"
    echo -e "      ${GRAY}- Available before you log in${NC}"
    echo -e "      ${GRAY}- Installs to /usr/local/bin${NC}"
    echo -e "      ${GRAY}- Terminals run as: $(whoami)${NC}"
    echo -e "      ${YELLOW}- Requires sudo privileges${NC}"
    echo ""
    echo -e "  ${CYAN}[2] User install${NC} (no sudo required)"
    echo -e "      ${GRAY}- You start it manually when needed${NC}"
    echo -e "      ${GRAY}- Only available after you log in${NC}"
    echo -e "      ${GRAY}- Installs to ~/.local/bin${NC}"
    echo -e "      ${GREEN}- No special permissions needed${NC}"
    echo ""

    read -p "  Your choice [1/2]: " choice < /dev/tty
    case "$choice" in
        2)
            SERVICE_MODE=false
            ;;
        *)
            SERVICE_MODE=true
            ;;
    esac
}

get_existing_password_hash() {
    local settings_path="/usr/local/etc/MidTerm/settings.json"
    if [ -f "$settings_path" ]; then
        local hash=$(grep -o '"passwordHash"[[:space:]]*:[[:space:]]*"[^"]*"' "$settings_path" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/')
        if [ -n "$hash" ] && [ ${#hash} -gt 10 ]; then
            echo "$hash"
            return 0
        fi
    fi
    return 1
}

prompt_password() {
    echo ""
    echo -e "  ${YELLOW}Security Notice:${NC}"
    echo -e "  ${GRAY}MidTerm exposes terminal access over the network.${NC}"
    echo -e "  ${GRAY}A password is required to prevent unauthorized access.${NC}"
    echo ""

    local max_attempts=3
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        read -s -p "  Enter password: " password < /dev/tty
        echo
        read -s -p "  Confirm password: " confirm < /dev/tty
        echo

        if [ "$password" != "$confirm" ]; then
            echo -e "  ${RED}Passwords do not match. Try again.${NC}"
            attempt=$((attempt + 1))
            continue
        fi

        if [ ${#password} -lt 4 ]; then
            echo -e "  ${RED}Password must be at least 4 characters.${NC}"
            attempt=$((attempt + 1))
            continue
        fi

        # Try to hash the password using mm --hash-password
        local mm_path="/usr/local/bin/mt"
        if [ -f "$mm_path" ]; then
            local hash=$("$mm_path" --hash-password "$password" 2>/dev/null || true)
            if [[ "$hash" == '$PBKDF2$'* ]]; then
                PASSWORD_HASH="$hash"
                return 0
            fi
        fi

        # Fallback: mark for first-run setup
        echo -e "  ${YELLOW}Warning: Could not hash password, will be set on first access.${NC}"
        PASSWORD_HASH="__PENDING__:$password"
        return 0
    done

    echo -e "  ${RED}Too many failed attempts. Exiting.${NC}"
    exit 1
}

prompt_network_config() {
    echo ""
    echo -e "  ${CYAN}Network Configuration:${NC}"
    echo ""

    # Port configuration
    read -p "  Port number [2000]: " port_input < /dev/tty
    if [ -z "$port_input" ]; then
        PORT=2000
    elif [[ "$port_input" =~ ^[0-9]+$ ]] && [ "$port_input" -ge 1 ] && [ "$port_input" -le 65535 ]; then
        PORT="$port_input"
    else
        echo -e "  ${YELLOW}Invalid port, using default 2000${NC}"
        PORT=2000
    fi

    echo ""
    echo -e "  ${CYAN}Network binding:${NC}"
    echo -e "  ${CYAN}[1] Accept connections from anywhere${NC} (default)"
    echo -e "      ${GRAY}- Access from other devices on your network${NC}"
    echo -e "      ${GRAY}- Required for remote access${NC}"
    echo ""
    echo -e "  ${CYAN}[2] Localhost only${NC}"
    echo -e "      ${GRAY}- Only accessible from this computer${NC}"
    echo -e "      ${GREEN}- More secure, no network exposure${NC}"
    echo ""

    read -p "  Your choice [1/2]: " bind_choice < /dev/tty

    if [ "$bind_choice" = "2" ]; then
        BIND_ADDRESS="127.0.0.1"
        echo -e "  ${GRAY}Binding to localhost only${NC}"
    else
        BIND_ADDRESS="0.0.0.0"
        echo ""
        echo -e "  ${YELLOW}Security Warning:${NC}"
        echo -e "  ${YELLOW}MidTerm will accept connections from any device on your network.${NC}"
        echo -e "  ${YELLOW}Ensure your password is strong and consider firewall rules.${NC}"
    fi
}

write_service_settings() {
    local config_dir="/usr/local/etc/MidTerm"
    local settings_path="$config_dir/settings.json"
    local old_settings_path="$config_dir/settings.json.old"

    mkdir -p "$config_dir"

    # Backup existing settings for migration by the app
    if [ -f "$settings_path" ]; then
        echo -e "  ${GRAY}Backing up existing settings...${NC}"
        mv "$settings_path" "$old_settings_path"
    fi

    # Write minimal bootstrap settings - app will migrate user preferences from .old
    if [ -n "$PASSWORD_HASH" ]; then
        cat > "$settings_path" << EOF
{
  "runAsUser": "$INSTALLING_USER",
  "runAsUid": $INSTALLING_UID,
  "runAsGid": $INSTALLING_GID,
  "authenticationEnabled": true,
  "passwordHash": "$PASSWORD_HASH"
}
EOF
        echo -e "  ${GRAY}Password: configured${NC}"
    else
        cat > "$settings_path" << EOF
{
  "runAsUser": "$INSTALLING_USER",
  "runAsUid": $INSTALLING_UID,
  "runAsGid": $INSTALLING_GID,
  "authenticationEnabled": true
}
EOF
    fi

    chmod 644 "$settings_path"
    echo -e "  ${GRAY}Terminal user: $INSTALLING_USER${NC}"
    echo -e "  ${GRAY}Port: $PORT${NC}"
    if [ "$BIND_ADDRESS" = "127.0.0.1" ]; then
        echo -e "  ${GRAY}Binding: localhost only${NC}"
    else
        echo -e "  ${GRAY}Binding: all interfaces${NC}"
    fi
}

write_user_settings() {
    local config_dir="$HOME/.MidTerm"
    local settings_path="$config_dir/settings.json"

    mkdir -p "$config_dir"

    if [ -n "$PASSWORD_HASH" ]; then
        cat > "$settings_path" << EOF
{
  "authenticationEnabled": true,
  "passwordHash": "$PASSWORD_HASH"
}
EOF
        echo -e "  ${GRAY}Password: configured${NC}"
    else
        cat > "$settings_path" << EOF
{
  "authenticationEnabled": true
}
EOF
    fi

    chmod 600 "$settings_path"
    echo -e "  ${GRAY}Settings: $settings_path${NC}"
}

get_existing_user_password_hash() {
    local settings_path="$HOME/.MidTerm/settings.json"
    if [ -f "$settings_path" ]; then
        local hash=$(grep -o '"passwordHash"[[:space:]]*:[[:space:]]*"[^"]*"' "$settings_path" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/')
        if [ -n "$hash" ] && [ ${#hash} -gt 10 ]; then
            echo "$hash"
            return 0
        fi
    fi
    return 1
}

install_binary() {
    local install_dir="$1"
    local temp_dir=$(mktemp -d)

    echo -e "${GRAY}Downloading...${NC}"
    curl -fsSL "$ASSET_URL" -o "$temp_dir/mt.tar.gz"

    echo -e "${GRAY}Extracting...${NC}"
    tar -xzf "$temp_dir/mt.tar.gz" -C "$temp_dir"

    # Create install directory
    mkdir -p "$install_dir"

    # Copy web binary
    cp "$temp_dir/mt" "$install_dir/"
    chmod +x "$install_dir/mt"

    # Copy con-host binary (terminal subprocess)
    if [ -f "$temp_dir/mtttyhost" ]; then
        cp "$temp_dir/mtttyhost" "$install_dir/"
        chmod +x "$install_dir/mtttyhost"
    fi

    # Copy version manifest
    if [ -f "$temp_dir/version.json" ]; then
        cp "$temp_dir/version.json" "$install_dir/"
    fi

    # Cleanup
    rm -rf "$temp_dir"

    # Remove legacy mt-host if present (from pre-v4)
    rm -f "$install_dir/mt-host"
}

install_as_service() {
    local install_dir="/usr/local/bin"
    local lib_dir="/usr/local/lib/MidTerm"

    # Check for root
    if [ "$EUID" -ne 0 ]; then
        echo ""
        echo -e "${YELLOW}Requesting sudo privileges...${NC}"
        # Re-exec with sudo, passing user info as environment variables
        exec sudo INSTALLING_USER="$INSTALLING_USER" \
                  INSTALLING_UID="$INSTALLING_UID" \
                  INSTALLING_GID="$INSTALLING_GID" \
                  PASSWORD_HASH="$PASSWORD_HASH" \
                  PORT="$PORT" \
                  BIND_ADDRESS="$BIND_ADDRESS" \
                  "$SCRIPT_PATH" --service
    fi

    install_binary "$install_dir"

    # Create lib directory for support files
    mkdir -p "$lib_dir"

    # Write settings with runAsUser info
    if [ -n "$INSTALLING_USER" ] && [ -n "$INSTALLING_UID" ]; then
        write_service_settings
    fi

    if [ "$(uname -s)" = "Darwin" ]; then
        install_launchd "$install_dir"
    else
        install_systemd "$install_dir"
    fi

    # Create uninstall script
    create_uninstall_script "$lib_dir" true

    echo ""
    echo -e "${GREEN}Installation complete!${NC}"
    echo ""
    echo -e "  ${GRAY}Location: $install_dir/mt${NC}"
    echo -e "  ${CYAN}URL:      http://localhost:$PORT${NC}"
    echo ""
}

install_launchd() {
    local install_dir="$1"
    local plist_path="/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist"
    local old_host_plist="/Library/LaunchDaemons/${OLD_LAUNCHD_HOST_LABEL}.plist"
    local log_dir="/usr/local/var/log"

    echo -e "${GRAY}Creating launchd service...${NC}"

    # Create log directory
    mkdir -p "$log_dir"

    # Unload existing services if present
    launchctl unload "$plist_path" 2>/dev/null || true

    # Migration: remove old host service from pre-v4
    if [ -f "$old_host_plist" ]; then
        echo -e "${YELLOW}Migrating from old architecture...${NC}"
        launchctl unload "$old_host_plist" 2>/dev/null || true
        rm -f "$old_host_plist"
    fi

    # Create service plist
    cat > "$plist_path" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${install_dir}/mt</string>
        <string>--port</string>
        <string>${PORT}</string>
        <string>--bind</string>
        <string>${BIND_ADDRESS}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${log_dir}/MidTerm.log</string>
    <key>StandardErrorPath</key>
    <string>${log_dir}/MidTerm.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
EOF

    # Load service
    echo -e "${GRAY}Starting service...${NC}"
    launchctl load "$plist_path"
}

install_systemd() {
    local install_dir="$1"
    local service_path="/etc/systemd/system/${SERVICE_NAME}.service"
    local old_host_service="/etc/systemd/system/${OLD_HOST_SERVICE_NAME}.service"

    echo -e "${GRAY}Creating systemd service...${NC}"

    # Unload existing service if present
    systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    systemctl disable "$SERVICE_NAME" 2>/dev/null || true

    # Migration: remove old host service from pre-v4
    if [ -f "$old_host_service" ]; then
        echo -e "${YELLOW}Migrating from old architecture...${NC}"
        systemctl stop "$OLD_HOST_SERVICE_NAME" 2>/dev/null || true
        systemctl disable "$OLD_HOST_SERVICE_NAME" 2>/dev/null || true
        rm -f "$old_host_service"
    fi

    # Create systemd service
    cat > "$service_path" << EOF
[Unit]
Description=MidTerm Terminal Server
After=network.target

[Service]
Type=simple
ExecStart=${install_dir}/mt --port ${PORT} --bind ${BIND_ADDRESS}
Restart=always
RestartSec=5
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
EOF

    # Reload and start service
    echo -e "${GRAY}Starting service...${NC}"
    systemctl daemon-reload
    systemctl enable "$SERVICE_NAME"
    systemctl start "$SERVICE_NAME"
}

install_as_user() {
    local install_dir="$HOME/.local/bin"

    install_binary "$install_dir"

    # Write user settings with password
    write_user_settings

    # Check if ~/.local/bin is in PATH
    if [[ ":$PATH:" != *":$install_dir:"* ]]; then
        echo ""
        echo -e "${YELLOW}Add this to your shell profile (~/.bashrc or ~/.zshrc):${NC}"
        echo ""
        echo -e "  export PATH=\"\$HOME/.local/bin:\$PATH\""
        echo ""
    fi

    # Create uninstall script
    local lib_dir="$HOME/.local/lib/MidTerm"
    mkdir -p "$lib_dir"

    create_uninstall_script "$lib_dir" false

    echo ""
    echo -e "${GREEN}Installation complete!${NC}"
    echo ""
    echo -e "  ${GRAY}Location: $install_dir/mt${NC}"
    echo -e "  ${YELLOW}Run 'mt' to start MidTerm${NC}"
    echo ""
}

create_uninstall_script() {
    local lib_dir="$1"
    local is_service="$2"

    local uninstall_script="$lib_dir/uninstall.sh"

    if [ "$is_service" = true ]; then
        cat > "$uninstall_script" << 'EOF'
#!/bin/bash
# MidTerm Uninstaller

set -e

echo "Uninstalling MidTerm..."

if [ "$(uname -s)" = "Darwin" ]; then
    # macOS - unload service
    sudo launchctl unload /Library/LaunchDaemons/com.aitlbx.MidTerm.plist 2>/dev/null || true
    sudo rm -f /Library/LaunchDaemons/com.aitlbx.MidTerm.plist
    # Cleanup old host service if present (from pre-v4)
    sudo launchctl unload /Library/LaunchDaemons/com.aitlbx.MidTerm-host.plist 2>/dev/null || true
    sudo rm -f /Library/LaunchDaemons/com.aitlbx.MidTerm-host.plist
else
    # Linux - stop and remove service
    sudo systemctl stop MidTerm 2>/dev/null || true
    sudo systemctl disable MidTerm 2>/dev/null || true
    sudo rm -f /etc/systemd/system/MidTerm.service
    # Cleanup old host service if present (from pre-v4)
    sudo systemctl stop MidTerm-host 2>/dev/null || true
    sudo systemctl disable MidTerm-host 2>/dev/null || true
    sudo rm -f /etc/systemd/system/MidTerm-host.service
    sudo systemctl daemon-reload
fi

sudo rm -f /usr/local/bin/mt
sudo rm -f /usr/local/bin/mtttyhost
sudo rm -f /usr/local/bin/mt-host  # legacy cleanup
sudo rm -rf /usr/local/lib/MidTerm
sudo rm -rf /usr/local/etc/MidTerm

echo "MidTerm uninstalled."
EOF
    else
        cat > "$uninstall_script" << EOF
#!/bin/bash
# MidTerm Uninstaller

set -e

echo "Uninstalling MidTerm..."

rm -f "$HOME/.local/bin/mt"
rm -f "$HOME/.local/bin/mtttyhost"
rm -f "$HOME/.local/bin/mt-host"  # legacy cleanup
rm -rf "$HOME/.local/lib/MidTerm"

echo "MidTerm uninstalled."
EOF
    fi

    chmod +x "$uninstall_script"
}

# Handle --service flag for sudo re-exec
if [ "$1" = "--service" ]; then
    SERVICE_MODE=true
    # Re-read release info (lost during sudo)
    detect_platform
    get_latest_release
    install_as_service
    exit 0
fi

# Capture current user info BEFORE any potential sudo
# This is critical - we need the real user, not root
if [ -z "$INSTALLING_USER" ]; then
    INSTALLING_USER=$(whoami)
    INSTALLING_UID=$(id -u)
    INSTALLING_GID=$(id -g)
fi

# Main
print_header
detect_platform
get_latest_release
prompt_service_mode

if [ "$SERVICE_MODE" = true ]; then
    # Check for existing password (preserve on update)
    existing_hash=$(get_existing_password_hash || true)
    if [ -n "$existing_hash" ]; then
        echo ""
        echo -e "  ${GREEN}Existing password found - preserving...${NC}"
        PASSWORD_HASH="$existing_hash"
    else
        # New install - prompt for password
        prompt_password
    fi

    # Prompt for network configuration
    prompt_network_config

    install_as_service
else
    # User install - still require password
    existing_hash=$(get_existing_user_password_hash || true)
    if [ -n "$existing_hash" ]; then
        echo ""
        echo -e "  ${GREEN}Existing password found - preserving...${NC}"
        PASSWORD_HASH="$existing_hash"
    else
        # New install - prompt for password
        prompt_password
    fi

    install_as_user
fi
