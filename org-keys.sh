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

usage() {
  echo ""
  echo "Usage: ./org-keys.sh <command> [options]"
  echo ""
  echo "Commands:"
  echo "  list                             List all org keys with usage counts"
  echo "  create <label> <keyLimit>        Create a new org key"
  echo "  update-limit <orgKeyId> <limit>  Update the key limit for an org"
  echo "  revoke <orgKeyId>                Revoke an org key"
  echo "  keys <orgKeyId>                  List API keys created under an org key"
  echo "  delete-key <apiKeyId>            Delete an API key"
  echo ""
  echo "Examples:"
  echo "  ./org-keys.sh list"
  echo "  ./org-keys.sh create amazon 500"
  echo "  ./org-keys.sh update-limit abc-123 1000"
  echo "  ./org-keys.sh revoke abc-123"
  echo "  ./org-keys.sh keys abc-123"
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
header = '  {:<38} {:<20} {:<12} {}'.format('ID', 'Label', 'Used/Limit', 'Created')
print(header)
print('  ' + '-'*85)
for k in data:
  used = k['keyCount']
  limit = k['keyLimit']
  created = k['createdAt'][:10]
  usage = str(used) + '/' + str(limit)
  print('  {:<38} {:<20} {:<12} {}'.format(k['id'], k['label'], usage, created))
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
print('  ID:        ', data['id'])
print('  Label:     ', data['label'])
print('  Key limit: ', data['keyLimit'])
print('  Created:   ', data['createdAt'][:10])
print('')
print('  RAW KEY (save this — shown only once):')
print('')
print(' ', data['rawKey'])
print('')
"
    ;;

  update-limit)
    if [ -z "$2" ] || [ -z "$3" ]; then
      echo "Usage: ./org-keys.sh update-limit <orgKeyId> <newLimit>"
      exit 1
    fi
    ID="$2"
    LIMIT="$3"
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$API/admin/org-keys/$ID" \
      -H "Authorization: Bearer $ADMIN_SECRET" \
      -H "Content-Type: application/json" \
      -d "{\"keyLimit\": $LIMIT}")
    if [ "$STATUS" = "204" ]; then
      echo "Key limit updated to $LIMIT."
    else
      echo "Failed (HTTP $STATUS). Check the ID with: ./org-keys.sh list"
    fi
    ;;

  revoke)
    if [ -z "$2" ]; then
      echo "Usage: ./org-keys.sh revoke <orgKeyId>"
      exit 1
    fi
    ID="$2"
    read -p "Revoke org key '$ID'? This will block all their future key creation. [y/N] " CONFIRM
    if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
      echo "Cancelled."
      exit 0
    fi
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$API/admin/org-keys/$ID" \
      -H "Authorization: Bearer $ADMIN_SECRET")
    if [ "$STATUS" = "204" ]; then
      echo "Org key revoked."
    else
      echo "Failed (HTTP $STATUS). Check the ID with: ./org-keys.sh list"
    fi
    ;;

  keys)
    if [ -z "$2" ]; then
      echo "Usage: ./org-keys.sh keys <orgKeyId>"
      exit 1
    fi
    # Admin lists all keys then filters by orgKeyId client-side
    echo "API keys under org '$2':"
    curl -s "$API/keys" \
      -H "Authorization: Bearer $ADMIN_SECRET" | \
      python3 -c "
import sys, json
org_id = '$2'
data = json.load(sys.stdin)
if isinstance(data, dict):
  print('  Error:', data.get('error', data))
  exit(1)
filtered = [k for k in data if k.get('orgKeyId') == org_id]
if not filtered:
  print('  (none)')
  exit()
header = '  {:<38} {:<25} {}'.format('ID', 'Label', 'Created')
print(header)
print('  ' + '-'*75)
for k in filtered:
  print('  {:<38} {:<25} {}'.format(k['id'], k['label'], k['createdAt'][:10]))
"
    ;;

  delete-key)
    if [ -z "$2" ]; then
      echo "Usage: ./org-keys.sh delete-key <apiKeyId>"
      exit 1
    fi
    ID="$2"
    read -p "Delete API key '$ID'? [y/N] " CONFIRM
    if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
      echo "Cancelled."
      exit 0
    fi
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$API/keys/$ID" \
      -H "Authorization: Bearer $ADMIN_SECRET")
    if [ "$STATUS" = "204" ]; then
      echo "API key deleted."
    else
      echo "Failed (HTTP $STATUS)."
    fi
    ;;

  *)
    usage
    ;;
esac
