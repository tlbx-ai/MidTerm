#!/bin/bash
# MidTerm macOS/Linux Installer
# Usage: curl -fsSL https://aitlbx.github.io/MidTerm/install.sh | bash

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
    echo -e "      ${GRAY}- Terminals run as: ${INSTALLING_USER}${NC}"
    echo -e "      ${YELLOW}- Requires sudo privileges${NC}"
    echo ""
    echo -e "  ${CYAN}[2] User install${NC} (no sudo required)"
    echo -e "      ${GRAY}- You start it manually when needed${NC}"
    echo -e "      ${GRAY}- Only available after you log in${NC}"
    echo -e "      ${GRAY}- Installs to ~/.local/bin${NC}"
    echo -e "      ${GREEN}- No special permissions needed${NC}"
    echo ""

    local max_attempts=3
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        read -p "  Your choice [1/2]: " choice < /dev/tty
        case "$choice" in
            ""|1)
                SERVICE_MODE=true
                return
                ;;
            2)
                SERVICE_MODE=false
                return
                ;;
            *)
                echo -e "  ${RED}Error: Please enter 1 or 2.${NC}"
                attempt=$((attempt + 1))
                if [ $attempt -lt $max_attempts ]; then
                    echo -e "  ${YELLOW}Please try again.${NC}"
                else
                    echo -e "  ${YELLOW}Using default: System service.${NC}"
                    SERVICE_MODE=true
                fi
                ;;
        esac
    done
}

get_existing_password_hash() {
    local settings_dir="/usr/local/etc/MidTerm"
    local secrets_path="$settings_dir/secrets.bin"
    local settings_path="$settings_dir/settings.json"
    local mt_path="/usr/local/bin/mt"

    # Check secrets.bin first (preferred secure storage)
    if [ -f "$secrets_path" ] && [ -f "$mt_path" ]; then
        local hash=$("$mt_path" --read-secret password_hash --service-mode 2>/dev/null || true)
        if [[ "$hash" == '$PBKDF2$'* ]]; then
            echo "$hash"
            return 0
        fi
    fi

    # Fall back to settings.json (legacy or migration)
    if [ -f "$settings_path" ]; then
        local hash=$(grep -o '"passwordHash"[[:space:]]*:[[:space:]]*"[^"]*"' "$settings_path" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/')
        if [[ "$hash" == '$PBKDF2$'* ]]; then
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

        # Try to hash using the installed binary
        local mt_path="${MT_BINARY_PATH:-/usr/local/bin/mt}"
        if [ -f "$mt_path" ]; then
            local hash=$(echo "$password" | "$mt_path" --hash-password 2>/dev/null || true)
            if [[ "$hash" == '$PBKDF2$'* ]]; then
                PASSWORD_HASH="$hash"
                return 0
            fi
        fi

        # Binary not available yet - use pending marker (hash after install)
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

    # Port configuration with validation and retry
    local max_attempts=3
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        read -p "  Port number [2000]: " port_input < /dev/tty
        if [ -z "$port_input" ]; then
            PORT=2000
            break
        elif [[ "$port_input" =~ ^[0-9]+$ ]] && [ "$port_input" -ge 1 ] && [ "$port_input" -le 65535 ]; then
            PORT="$port_input"
            break
        else
            if [[ ! "$port_input" =~ ^[0-9]+$ ]]; then
                echo -e "  ${RED}Error: Port must be a number.${NC}"
            else
                echo -e "  ${RED}Error: Port must be between 1 and 65535.${NC}"
            fi
            attempt=$((attempt + 1))
            if [ $attempt -lt $max_attempts ]; then
                echo -e "  ${YELLOW}Please try again.${NC}"
            else
                echo -e "  ${YELLOW}Using default port 2000.${NC}"
                PORT=2000
            fi
        fi
    done

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

    # Binding choice with validation and retry
    attempt=0
    while [ $attempt -lt $max_attempts ]; do
        read -p "  Your choice [1/2]: " bind_choice < /dev/tty

        case "$bind_choice" in
            ""|1)
                BIND_ADDRESS="0.0.0.0"
                echo ""
                echo -e "  ${YELLOW}Security Warning:${NC}"
                echo -e "  ${YELLOW}MidTerm will accept connections from any device on your network.${NC}"
                echo -e "  ${YELLOW}Ensure your password is strong and consider firewall rules.${NC}"
                break
                ;;
            2)
                BIND_ADDRESS="127.0.0.1"
                echo -e "  ${GRAY}Binding to localhost only${NC}"
                break
                ;;
            *)
                echo -e "  ${RED}Error: Please enter 1 or 2.${NC}"
                attempt=$((attempt + 1))
                if [ $attempt -lt $max_attempts ]; then
                    echo -e "  ${YELLOW}Please try again.${NC}"
                else
                    echo -e "  ${YELLOW}Using default: accept connections from anywhere.${NC}"
                    BIND_ADDRESS="0.0.0.0"
                fi
                ;;
        esac
    done

    echo ""
    echo -e "  ${GREEN}HTTPS: Enabled${NC}"
}

show_certificate_fingerprint() {
    local cert_path="$1"

    if [ -z "$cert_path" ] || [ ! -f "$cert_path" ]; then
        return
    fi

    # Compute SHA-256 fingerprint using openssl
    local fingerprint
    fingerprint=$(openssl x509 -in "$cert_path" -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2)

    if [ -n "$fingerprint" ]; then
        echo ""
        echo -e "  ${CYAN}================================================${NC}"
        echo -e "  ${CYAN}CERTIFICATE FINGERPRINT - SAVE THIS!${NC}"
        echo -e "  ${CYAN}================================================${NC}"
        echo ""
        echo -e "  ${YELLOW}$fingerprint${NC}"
        echo ""
        echo -e "  ${GRAY}When connecting from other devices, verify the${NC}"
        echo -e "  ${GRAY}fingerprint in your browser matches this one.${NC}"
        echo -e "  ${GRAY}(Click padlock icon > Certificate > SHA-256)${NC}"
        echo ""
        echo -e "  Never enter passwords if fingerprints don't match."
        echo ""
    fi
}

generate_certificate() {
    local install_dir="$1"
    local settings_dir="$2"

    mkdir -p "$settings_dir"

    echo ""
    echo -e "  ${GRAY}Generating self-signed certificate with OS-protected key...${NC}"

    local mt_path="$install_dir/mt"
    if [ ! -f "$mt_path" ]; then
        echo -e "  ${RED}Error: mt not found at $mt_path${NC}"
        return 1
    fi

    # Use mt --generate-cert to generate certificate with encrypted private key
    local output
    output=$("$mt_path" --generate-cert 2>&1)
    local exit_code=$?

    if [ $exit_code -ne 0 ]; then
        echo -e "  ${RED}Failed to generate certificate: $output${NC}"
        return 1
    fi

    # Parse output for certificate path
    CERT_PATH=$(echo "$output" | grep -o "Certificate saved to: .*\.pem" | sed 's/Certificate saved to: //' | tr -d ' ')
    if [ -z "$CERT_PATH" ]; then
        # Default path
        CERT_PATH="$settings_dir/midterm-cert.pem"
    fi

    echo -e "  ${GREEN}Certificate generated with OS-protected private key${NC}"

    # Show trust instructions
    if [ "$(uname -s)" = "Darwin" ]; then
        echo ""
        echo -e "  ${YELLOW}To trust the certificate (may require password):${NC}"
        echo -e "  ${GRAY}sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \"$CERT_PATH\"${NC}"
    else
        echo ""
        echo -e "  ${YELLOW}To trust the certificate on Linux:${NC}"
        echo -e "  ${GRAY}sudo cp \"$CERT_PATH\" /usr/local/share/ca-certificates/midterm.crt${NC}"
        echo -e "  ${GRAY}sudo update-ca-certificates${NC}"
    fi

    return 0
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

    # Build JSON - passwordHash NOT included (stored in secrets.bin)
    local json_content="{
  \"runAsUser\": \"$INSTALLING_USER\",
  \"authenticationEnabled\": true"

    if [ -n "$CERT_PATH" ]; then
        json_content="$json_content,
  \"certificatePath\": \"$CERT_PATH\",
  \"keyProtection\": \"osProtected\""
        echo -e "  ${GREEN}HTTPS: enabled (OS-protected key)${NC}"
    fi

    json_content="$json_content
}"

    echo "$json_content" > "$settings_path"
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
    local old_settings_path="$config_dir/settings.json.old"

    mkdir -p "$config_dir"

    # Backup existing settings for migration by the app
    if [ -f "$settings_path" ]; then
        echo -e "  ${GRAY}Backing up existing settings...${NC}"
        mv "$settings_path" "$old_settings_path"
    fi

    # Build JSON - passwordHash NOT included (stored in secrets.bin)
    local json_content="{
  \"authenticationEnabled\": true"

    if [ -n "$CERT_PATH" ]; then
        json_content="$json_content,
  \"certificatePath\": \"$CERT_PATH\",
  \"keyProtection\": \"osProtected\""
        echo -e "  ${GREEN}HTTPS: enabled (OS-protected key)${NC}"
    fi

    json_content="$json_content
}"

    echo "$json_content" > "$settings_path"
    chmod 600 "$settings_path"
    echo -e "  ${GRAY}Settings: $settings_path${NC}"
}

get_existing_user_password_hash() {
    local settings_dir="$HOME/.MidTerm"
    local secrets_path="$settings_dir/secrets.bin"
    local settings_path="$settings_dir/settings.json"
    local mt_path="$HOME/.local/bin/mt"

    # Check secrets.bin first (preferred secure storage)
    if [ -f "$secrets_path" ] && [ -f "$mt_path" ]; then
        local hash=$("$mt_path" --read-secret password_hash 2>/dev/null || true)
        if [[ "$hash" == '$PBKDF2$'* ]]; then
            echo "$hash"
            return 0
        fi
    fi

    # Fall back to settings.json (legacy or migration)
    if [ -f "$settings_path" ]; then
        local hash=$(grep -o '"passwordHash"[[:space:]]*:[[:space:]]*"[^"]*"' "$settings_path" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/')
        if [[ "$hash" == '$PBKDF2$'* ]]; then
            echo "$hash"
            return 0
        fi
    fi
    return 1
}

copy_with_retry() {
    local src="$1"
    local dest="$2"
    local max_retries=15
    local delay_ms=500

    for ((i=0; i<max_retries; i++)); do
        if cp "$src" "$dest" 2>/dev/null; then
            return 0
        fi
        [ $i -eq 0 ] && echo -e "  ${YELLOW}Waiting for file to be released...${NC}"
        sleep 0.$delay_ms
    done
    return 1
}

check_existing_certificate() {
    local cert_path="$1"
    [ ! -f "$cert_path" ] && return 1

    # Check expiry using openssl
    local expiry_date
    expiry_date=$(openssl x509 -in "$cert_path" -noout -enddate 2>/dev/null | cut -d= -f2)
    [ -z "$expiry_date" ] && return 1

    # Parse expiry date - try GNU date first, then BSD date
    local expiry_ts now_ts
    expiry_ts=$(date -d "$expiry_date" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "$expiry_date" +%s 2>/dev/null)
    [ -z "$expiry_ts" ] && return 1

    now_ts=$(date +%s)
    local days_left=$(( (expiry_ts - now_ts) / 86400 ))

    if [ $days_left -lt 0 ]; then
        echo -e "  ${YELLOW}Existing certificate has expired${NC}"
        return 1
    elif [ $days_left -lt 30 ]; then
        echo -e "  ${YELLOW}Certificate expires in $days_left days - regenerating${NC}"
        return 1
    fi

    echo -e "  ${GREEN}Existing certificate valid (expires in $days_left days)${NC}"
    return 0
}

prompt_certificate_trust() {
    local cert_path="$1"

    echo ""
    echo -e "  ${CYAN}Certificate Trust:${NC}"
    echo -e "  ${YELLOW}Trust the certificate to remove browser warnings?${NC}"
    read -p "  Trust certificate? [Y/n]: " trust_choice < /dev/tty

    if [[ "$trust_choice" != "n" && "$trust_choice" != "N" ]]; then
        if [ "$(uname -s)" = "Darwin" ]; then
            if sudo security add-trusted-cert -d -r trustRoot \
                -k /Library/Keychains/System.keychain "$cert_path" 2>/dev/null; then
                echo -e "  ${GREEN}Certificate trusted${NC}"
            else
                echo -e "  ${YELLOW}Could not auto-trust - use manual command above${NC}"
            fi
        else
            if sudo cp "$cert_path" /usr/local/share/ca-certificates/midterm.crt 2>/dev/null && \
               sudo update-ca-certificates 2>/dev/null; then
                echo -e "  ${GREEN}Certificate trusted${NC}"
            else
                echo -e "  ${YELLOW}Could not auto-trust - use manual commands above${NC}"
            fi
        fi
    fi
}

check_health() {
    local port="$1"
    sleep 2

    # Try curl with insecure flag (self-signed cert)
    if curl -fsSk "https://localhost:$port/api/health" >/dev/null 2>&1; then
        echo -e "  ${GREEN}Health check passed${NC}"
        return 0
    else
        echo -e "  ${YELLOW}Health check pending - check logs if issues persist${NC}"
        return 1
    fi
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

    # Copy web binary with retry (handles file lock during updates)
    if ! copy_with_retry "$temp_dir/mt" "$install_dir/mt"; then
        echo -e "${RED}Failed to copy mt - file locked${NC}"
        rm -rf "$temp_dir"
        exit 1
    fi
    chmod +x "$install_dir/mt"

    # Copy tty host binary (terminal subprocess)
    if [ -f "$temp_dir/mthost" ]; then
        if ! copy_with_retry "$temp_dir/mthost" "$install_dir/mthost"; then
            echo -e "${RED}Failed to copy mthost - file locked${NC}"
            rm -rf "$temp_dir"
            exit 1
        fi
        chmod +x "$install_dir/mthost"
    fi

    # Copy version manifest
    if [ -f "$temp_dir/version.json" ]; then
        copy_with_retry "$temp_dir/version.json" "$install_dir/version.json" || true
    fi

    # Cleanup
    rm -rf "$temp_dir"

    # Remove legacy mt-host if present (from pre-v4)
    rm -f "$install_dir/mt-host"
}

install_as_service() {
    local install_dir="/usr/local/bin"
    local lib_dir="/usr/local/lib/MidTerm"
    local settings_dir="/usr/local/etc/MidTerm"

    # Check for root
    if [ "$EUID" -ne 0 ]; then
        echo ""
        echo -e "${YELLOW}Requesting sudo privileges...${NC}"
        # Re-exec with sudo, passing user info as environment variables
        exec sudo env INSTALLING_USER="$INSTALLING_USER" \
                     INSTALLING_UID="$INSTALLING_UID" \
                     INSTALLING_GID="$INSTALLING_GID" \
                     PORT="$PORT" \
                     BIND_ADDRESS="$BIND_ADDRESS" \
                     "$SCRIPT_PATH" --service
    fi

    install_binary "$install_dir"

    # Create lib directory for support files
    mkdir -p "$lib_dir"

    # Now that binary is installed, handle password
    existing_hash=$(get_existing_password_hash || true)
    if [ -n "$existing_hash" ]; then
        echo -e "  ${GREEN}Existing password found - preserving...${NC}"
        PASSWORD_HASH="$existing_hash"
    else
        MT_BINARY_PATH="$install_dir/mt" prompt_password
    fi

    # Hash pending password now that binary is installed
    if [[ "$PASSWORD_HASH" == "__PENDING__:"* ]]; then
        local plain_password="${PASSWORD_HASH#__PENDING__:}"
        local hash
        hash=$(echo "$plain_password" | "$install_dir/mt" --hash-password 2>/dev/null || true)
        if [[ "$hash" == '$PBKDF2$'* ]]; then
            PASSWORD_HASH="$hash"
        else
            echo -e "  ${RED}Failed to hash password${NC}"
            exit 1
        fi
    fi

    # Store password in secrets.bin (secure storage)
    if [ -n "$PASSWORD_HASH" ] && [[ "$PASSWORD_HASH" == '$PBKDF2$'* ]]; then
        if echo "$PASSWORD_HASH" | "$install_dir/mt" --write-secret password_hash --service-mode 2>/dev/null; then
            echo -e "  ${GRAY}Password: stored securely${NC}"
        else
            echo -e "  ${YELLOW}Warning: Could not store password in secure storage${NC}"
        fi
    fi

    # Check existing certificate before generating
    local existing_cert="$settings_dir/midterm-cert.pem"
    if check_existing_certificate "$existing_cert"; then
        CERT_PATH="$existing_cert"
    elif ! generate_certificate "$install_dir" "$settings_dir"; then
        echo -e "  ${YELLOW}Certificate generation failed - app will use fallback certificate${NC}"
    else
        # Show fingerprint so user can verify connections from other devices
        show_certificate_fingerprint "$CERT_PATH"
        # Offer to trust certificate
        prompt_certificate_trust "$CERT_PATH"
    fi

    # Write settings with runAsUser info
    if [ -n "$INSTALLING_USER" ] && [ -n "$INSTALLING_UID" ]; then
        write_service_settings
    fi

    if [ "$(uname -s)" = "Darwin" ]; then
        install_launchd "$install_dir"
    else
        install_systemd "$install_dir"
    fi

    # Health check after service start
    check_health "$PORT"

    # Create uninstall script
    create_uninstall_script "$lib_dir" true

    echo ""
    echo -e "${GREEN}Installation complete!${NC}"
    echo ""
    echo -e "  ${GRAY}Location: $install_dir/mt${NC}"
    echo -e "  ${CYAN}URL:      https://localhost:$PORT${NC}"
    echo -e "  ${YELLOW}Note:     Browser may show certificate warning until trusted${NC}"
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
    if launchctl load "$plist_path"; then
        sleep 1
        if launchctl list | grep -q "$LAUNCHD_LABEL"; then
            echo -e "  ${GREEN}Service started successfully${NC}"
        else
            echo -e "  ${YELLOW}Service may still be starting...${NC}"
        fi
    else
        echo -e "  ${RED}Failed to start service${NC}"
        echo -e "  ${GRAY}Check logs at: /usr/local/var/log/MidTerm.log${NC}"
    fi
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

    if systemctl start "$SERVICE_NAME"; then
        # Give it a moment to initialize
        sleep 1
        if systemctl is-active --quiet "$SERVICE_NAME"; then
            echo -e "  ${GREEN}Service started successfully${NC}"
        else
            echo -e "  ${YELLOW}Service may still be starting...${NC}"
        fi
    else
        echo -e "  ${RED}Failed to start service${NC}"
        echo -e "  ${GRAY}Check logs with: journalctl -u $SERVICE_NAME -f${NC}"
    fi
}

install_as_user() {
    local install_dir="$HOME/.local/bin"
    local settings_dir="$HOME/.MidTerm"

    install_binary "$install_dir"

    # Now that binary is installed, handle password
    existing_hash=$(get_existing_user_password_hash || true)
    if [ -n "$existing_hash" ]; then
        echo -e "  ${GREEN}Existing password found - preserving...${NC}"
        PASSWORD_HASH="$existing_hash"
    else
        MT_BINARY_PATH="$install_dir/mt" prompt_password
    fi

    # Hash pending password now that binary is installed
    if [[ "$PASSWORD_HASH" == "__PENDING__:"* ]]; then
        local plain_password="${PASSWORD_HASH#__PENDING__:}"
        local hash
        hash=$(echo "$plain_password" | "$install_dir/mt" --hash-password 2>/dev/null || true)
        if [[ "$hash" == '$PBKDF2$'* ]]; then
            PASSWORD_HASH="$hash"
        else
            echo -e "  ${RED}Failed to hash password${NC}"
            exit 1
        fi
    fi

    # Store password in secrets.bin (secure storage)
    if [ -n "$PASSWORD_HASH" ] && [[ "$PASSWORD_HASH" == '$PBKDF2$'* ]]; then
        if echo "$PASSWORD_HASH" | "$install_dir/mt" --write-secret password_hash 2>/dev/null; then
            echo -e "  ${GRAY}Password: stored securely${NC}"
        else
            echo -e "  ${YELLOW}Warning: Could not store password in secure storage${NC}"
        fi
    fi

    # Check existing certificate before generating
    local existing_cert="$settings_dir/midterm-cert.pem"
    if check_existing_certificate "$existing_cert"; then
        CERT_PATH="$existing_cert"
    elif ! generate_certificate "$install_dir" "$settings_dir"; then
        echo -e "  ${YELLOW}Certificate generation failed - app will use fallback certificate${NC}"
    else
        # Show fingerprint so user can verify connections from other devices
        show_certificate_fingerprint "$CERT_PATH"
        # Offer to trust certificate (user mode - no sudo available, may fail)
        prompt_certificate_trust "$CERT_PATH"
    fi

    # Write user settings
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
    echo -e "  ${YELLOW}Note: Browser may show certificate warning until trusted${NC}"
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
sudo rm -f /usr/local/bin/mthost
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
rm -f "$HOME/.local/bin/mthost"
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
    # Check SUDO_USER first - set by sudo to the original invoking user
    # This handles cases where user runs "sudo ./install.sh" directly
    if [ -n "$SUDO_USER" ]; then
        INSTALLING_USER="$SUDO_USER"
        INSTALLING_UID=$(id -u "$SUDO_USER")
        INSTALLING_GID=$(id -g "$SUDO_USER")
    else
        INSTALLING_USER=$(whoami)
        INSTALLING_UID=$(id -u)
        INSTALLING_GID=$(id -g)
    fi
fi

# Main
print_header
detect_platform
get_latest_release
prompt_service_mode

if [ "$SERVICE_MODE" = true ]; then
    # Prompt for network configuration (password handled after binary install)
    prompt_network_config "/usr/local/etc/MidTerm"
    install_as_service
else
    install_as_user
fi
