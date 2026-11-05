#!/bin/sh
# ტელეფონის ფილტრს CRM-იდან გადმოიტანს. CRM-ის რეპოს მისამართი არგუმენტია.
# გამოყენება: sh tools/sync-phone-filter.sh ~/Documents/GitHub/Synexia-Admin/index.html
set -e
CRM="${1:-$HOME/Documents/GitHub/Synexia-Admin/index.html}"
OUT="$(dirname "$0")/../assets/phone-filter.js"
python3 - "$CRM" "$OUT" <<'PY'
import re,sys
src=open(sys.argv[1],encoding='utf-8').read()
pats=[r'const PH_TR = \{[\s\S]*?\};', r'function phNorm\(m\) \{[\s\S]*?\n\}',
      r'const PH_BRAND_KW = \[[\s\S]*?\n\];', r'const PH_UNK = \[.*?\];',
      r'const PH_NOMODEL = .*?;', r'const PH_JUNK = .*?;',
      r'function phBrand\(t\) \{[\s\S]*?\n\}', r'const PH_ALLOW = \{[\s\S]*?\n\};',
      r'function phCheck\(raw\) \{[\s\S]*?\n\}']
head = open(sys.argv[2],encoding='utf-8').read().split('\nconst PH_TR')[0]
body = '\n'.join(re.search(p,src).group(0) for p in pats)
open(sys.argv[2],'w',encoding='utf-8').write(head + '\n' + body + '\n\nwindow.phCheck = phCheck;\n')
print('განახლდა:', sys.argv[2])
PY
