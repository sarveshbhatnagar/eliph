#!/bin/bash

API="https://eliph-api.revalent.ai"

# Read ADMIN_SECRET from env or ecosystem.config.js
if [ -z "$ADMIN_SECRET" ]; then
  ADMIN_SECRET=$(grep -o "ADMIN_SECRET: '[^']*'" ecosystem.config.js 2>/dev/null | cut -d"'" -f2)
fi

if [ -z "$ADMIN_SECRET" ] || [ "$ADMIN_SECRET" = "replace-with-a-long-random-secret" ]; then
  echo "Error: ADMIN_SECRET not set. Either:"
  echo "  export ADMIN_SECRET=your-secret"
  echo "  or update ecosystem.config.js"
  exit 1
fi

# Resolve a label or ID to an org key ID.
# Prints the ID if found, empty string if not.
resolve_org_id() {
  local INPUT="$1"
  curl -s "$API/admin/org-keys" \
    -H "Authorization: Bearer $ADMIN_SECRET" | \
    python3 -c "
import sys, json
data = json.load(sys.stdin)
if isinstance(data, dict):
  sys.exit(1)
inp = '$INPUT'
# Exact label match first, then ID match
for k in data:
  if k['label'] == inp or k['id'] == inp:
    print(k['id'])
    sys.exit(0)
sys.exit(1)
"
}

usage() {
  echo ""
  echo "Usage: ./org-keys.sh <command> [options]"
  echo ""
  echo "Commands:"
  echo "  list                              List all org keys with usage counts"
  echo "  create <label> <keyLimit>         Create a new org key"
  echo "  update-limit <label> <newLimit>   Update the key limit for an org"
  echo "  regenerate <label>                Issue a new master key (old one stops working)"
  echo "  revoke <label>                    Revoke an org key entirely"
  echo "  keys <label>                      List API keys created under an org"
  echo "  delete-key <label> <keyLabel>     Delete an API key by org + key label"
  echo ""
  echo "Examples:"
  echo "  ./org-keys.sh list"
  echo "  ./org-keys.sh create amazon 500"
  echo "  ./org-keys.sh update-limit amazon 1000"
  echo "  ./org-keys.sh regenerate amazon"
  echo "  ./org-keys.sh revoke amazon"
  echo "  ./org-keys.sh keys amazon"
  echo "  ./org-keys.sh delete-key amazon prod-key-1"
  echo ""
}

case "$1" in

  list)
    echo "Org keys:"
    curl -s "$API/admin/org-keys" \
      -H "Authorization: Bearer $ADMIN_SECRET" | \
      python3 -c "
import sys, json
data = json.load(sys.stdin)
if isinstance(data, dict):
  print('  Error:', data.get('error', data))
  exit(1)
if not data:
  print('  (none)')
  exit()
header = '  {:<20} {:<12} {:<10} {}'.format('Label', 'Used/Limit', 'Created', 'ID')
print(header)
print('  ' + '-'*85)
for k in data:
  used = k['keyCount']
  limit = k['keyLimit']
  created = k['createdAt'][:10]
  usage = str(used) + '/' + str(limit)
  print('  {:<20} {:<12} {:<10} {}'.format(k['label'], usage, created, k['id']))
"
    ;;

  create)
    if [ -z "$2" ] || [ -z "$3" ]; then
      echo "Usage: ./org-keys.sh create <label> <keyLimit>"
      exit 1
    fi
    LABEL="$2"
    LIMIT="$3"
    echo "Creating org key for '$LABEL' with limit $LIMIT..."
    echo ""
    curl -s -X POST "$API/admin/org-keys" \
      -H "Authorization: Bearer $ADMIN_SECRET" \
      -H "Content-Type: application/json" \
      -d "{\"label\": \"$LABEL\", \"keyLimit\": $LIMIT}" | \
      python3 -c "
import sys, json
data = json.load(sys.stdin)
if 'error' in data:
  print('Error:', data['error'])
  exit(1)
print('Org key created!')
print('')
print('  Label:     ', data['label'])
print('  Key limit: ', data['keyLimit'])
print('  Created:   ', data['createdAt'][:10])
print('  ID:        ', data['id'])
print('')
print('  RAW KEY (save this — shown only once):')
print('')
print(' ', data['rawKey'])
print('')
"
    ;;

  regenerate)
    if [ -z "$2" ]; then
      echo "Usage: ./org-keys.sh regenerate <label>"
      exit 1
    fi
    ID=$(resolve_org_id "$2")
    if [ -z "$ID" ]; then
      echo "Error: org '$2' not found. Run './org-keys.sh list' to see all orgs."
      exit 1
    fi
    read -p "Regenerate master key for '$2'? The old key will stop working immediately. [y/N] " CONFIRM
    if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
      echo "Cancelled."
      exit 0
    fi
    curl -s -X POST "$API/admin/org-keys/$ID/regenerate" \
      -H "Authorization: Bearer $ADMIN_SECRET" | \
      python3 -c "
import sys, json
data = json.load(sys.stdin)
if 'error' in data:
  print('Error:', data['error'])
  exit(1)
print('New master key for org (share this with the customer):')
print('')
print(' ', data['rawKey'])
print('')
print('The old key is now invalid.')
"
    ;;

  update-limit)
    if [ -z "$2" ] || [ -z "$3" ]; then
      echo "Usage: ./org-keys.sh update-limit <label> <newLimit>"
      exit 1
    fi
    ID=$(resolve_org_id "$2")
    if [ -z "$ID" ]; then
      echo "Error: org '$2' not found. Run './org-keys.sh list' to see all orgs."
      exit 1
    fi
    LIMIT="$3"
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$API/admin/org-keys/$ID" \
      -H "Authorization: Bearer $ADMIN_SECRET" \
      -H "Content-Type: application/json" \
      -d "{\"keyLimit\": $LIMIT}")
    if [ "$STATUS" = "204" ]; then
      echo "Key limit for '$2' updated to $LIMIT."
    else
      echo "Failed (HTTP $STATUS)."
    fi
    ;;

  revoke)
    if [ -z "$2" ]; then
      echo "Usage: ./org-keys.sh revoke <label>"
      exit 1
    fi
    ID=$(resolve_org_id "$2")
    if [ -z "$ID" ]; then
      echo "Error: org '$2' not found. Run './org-keys.sh list' to see all orgs."
      exit 1
    fi
    read -p "Revoke org key for '$2'? This blocks all their future key creation. [y/N] " CONFIRM
    if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
      echo "Cancelled."
      exit 0
    fi
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$API/admin/org-keys/$ID" \
      -H "Authorization: Bearer $ADMIN_SECRET")
    if [ "$STATUS" = "204" ]; then
      echo "Org key for '$2' revoked."
    else
      echo "Failed (HTTP $STATUS)."
    fi
    ;;

  keys)
    if [ -z "$2" ]; then
      echo "Usage: ./org-keys.sh keys <label>"
      exit 1
    fi
    ID=$(resolve_org_id "$2")
    if [ -z "$ID" ]; then
      echo "Error: org '$2' not found. Run './org-keys.sh list' to see all orgs."
      exit 1
    fi
    echo "API keys under org '$2':"
    curl -s "$API/keys" \
      -H "Authorization: Bearer $ADMIN_SECRET" | \
      python3 -c "
import sys, json
org_id = '$ID'
data = json.load(sys.stdin)
if isinstance(data, dict):
  print('  Error:', data.get('error', data))
  exit(1)
filtered = [k for k in data if k.get('orgKeyId') == org_id]
if not filtered:
  print('  (none)')
  exit()
header = '  {:<25} {:<10} {}'.format('Label', 'Created', 'ID')
print(header)
print('  ' + '-'*75)
for k in filtered:
  print('  {:<25} {:<10} {}'.format(k['label'], k['createdAt'][:10], k['id']))
"
    ;;

  delete-key)
    if [ -z "$2" ] || [ -z "$3" ]; then
      echo "Usage: ./org-keys.sh delete-key <orgLabel> <keyLabel>"
      exit 1
    fi
    ORG_ID=$(resolve_org_id "$2")
    if [ -z "$ORG_ID" ]; then
      echo "Error: org '$2' not found. Run './org-keys.sh list' to see all orgs."
      exit 1
    fi
    KEY_LABEL="$3"
    KEY_ID=$(curl -s "$API/keys" \
      -H "Authorization: Bearer $ADMIN_SECRET" | \
      python3 -c "
import sys, json
data = json.load(sys.stdin)
if isinstance(data, dict):
  sys.exit(1)
for k in data:
  if k.get('orgKeyId') == '$ORG_ID' and k.get('label') == '$KEY_LABEL':
    print(k['id'])
    sys.exit(0)
sys.exit(1)
")
    if [ -z "$KEY_ID" ]; then
      echo "Error: key '$KEY_LABEL' not found under org '$2'."
      echo "Run './org-keys.sh keys $2' to see their keys."
      exit 1
    fi
    read -p "Delete key '$KEY_LABEL' from org '$2'? [y/N] " CONFIRM
    if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
      echo "Cancelled."
      exit 0
    fi
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$API/keys/$KEY_ID" \
      -H "Authorization: Bearer $ADMIN_SECRET")
    if [ "$STATUS" = "204" ]; then
      echo "Key '$KEY_LABEL' deleted from org '$2'."
    else
      echo "Failed (HTTP $STATUS)."
    fi
    ;;

  *)
    usage
    ;;
esac
