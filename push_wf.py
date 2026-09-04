import base64, json, urllib.request, urllib.error, sys
U = sys.argv[1]; P = sys.argv[2]
API = "https://api.github.com"; REPO = "joker-lyy/hyy-dashboard"
def req(method, path, data=None):
    url = f"{API}{path}"
    h = {"Authorization": f"Basic {base64.b64encode(f'{U}:{P}'.encode()).decode()}",
         "Accept": "application/vnd.github+json", "Content-Type": "application/json"}
    body = json.dumps(data).encode() if data is not None else None
    r = urllib.request.Request(url, data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]
path = ".github/workflows/update-data.yml"
with open(path, "rb") as f: content = f.read()
st, meta = req("GET", f"/repos/{REPO}/contents/{path}")
print("GET", path, st)
if st != 200:
    print("ERR", meta); sys.exit(1)
sha = meta["sha"]
b64 = base64.b64encode(content).decode()
st2, resp = req("PUT", f"/repos/{REPO}/contents/{path}", {
    "message": "chore(ci): 定时拉数改为北京时间 09/11/14/16 点（每天4次）",
    "content": b64, "sha": sha, "branch": "main"})
print("PUT", path, "http=", st2, resp.get('commit',{}).get('sha','?')[:8] if st2==200 else resp)
