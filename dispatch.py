import base64, json, urllib.request, urllib.error, sys
U = sys.argv[1]; P = sys.argv[2]
API = "https://api.github.com"; REPO = "joker-lyy/hyy-dashboard"
h = {"Authorization": f"Basic {base64.b64encode(f'{U}:{P}'.encode()).decode()}",
     "Accept": "application/vnd.github+json", "Content-Type": "application/json"}
body = json.dumps({"ref":"main"}).encode()
url = f"{API}/repos/{REPO}/actions/workflows/update-data.yml/dispatches"
r = urllib.request.Request(url, data=body, headers=h, method="POST")
try:
    with urllib.request.urlopen(r, timeout=30) as resp:
        print("dispatch status=", resp.status)
except urllib.error.HTTPError as e:
    print("dispatch HTTPError status=", e.code, e.read().decode()[:200])
