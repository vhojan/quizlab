# QuizLab 🎯

**Open-source, self-hosted Kahoot alternative.**
Real-time quiz platform for events, classrooms, and teams — built with Node.js, SQLite, and WebSockets.

---

## Features

| Feature | Detail |
|---------|--------|
| 🗃️ Quiz management | Create / edit / delete quizzes and questions via a web UI |
| ✏️ Question editor | Multiple-choice (4 options) or open numeric questions |
| 🎮 Game sessions | Launch a game, get a 6-digit PIN, players join by PIN |
| 🔐 Passwordless join | Players register with name + email — no account needed |
| ⚡ Speed scoring | Correct answer = base pts + up to 500 speed bonus |
| 📊 Live leaderboard | Shown automatically every 5 questions + at the end |
| 🏆 Winners podium | Gold / silver / bronze at the end |
| 🔄 Auto-reconnect | Players and hosts reconnect seamlessly if they drop |
| 🎨 ITQ branding | Royal Blue · Sky Blue · Teal · Green gradient bar |

---

## Architecture

```
Browser (player / host)
    │  HTTP REST  +  WebSocket (ws://)
    ▼
Node.js (Express + ws)          ← single process, stateful
    │
    ├── /api/...                REST endpoints (quiz CRUD, game control)
    ├── WebSocket               Real-time game engine
    └── /frontend/public/       Static SPA (single index.html)
    │
SQLite (/data/quizlab.db)       ← persisted via PVC
```

**Why single replica?**
WebSocket room state and SQLite live in the same process. For an event-scale deployment (< 200 concurrent players) this is perfectly sufficient. If you ever need HA, move state to Redis + Postgres — the architecture supports it.

---

## Quick start (local)

```bash
cd quizlab
npm install   # from backend/
# or:
cd backend && npm install

# Set env vars (or use defaults)
export HOST_PASSWORD=itq2026
export DB_PATH=./quizlab.db

node backend/server.js
```

Then open:
- **Player view:** http://localhost:3000
- **Host login:** http://localhost:3000  → click "Host Login"

---

## Build & push Docker image

```bash
# From repo root
docker build -t ghcr.io/YOUR_ORG/quizlab:latest .
docker push ghcr.io/YOUR_ORG/quizlab:latest
```

---

## Deploy to Kubernetes

```bash
# 1. Edit the secret in k8s/manifests.yaml (HOST_PASSWORD)
# 2. Set your image name
# 3. Set your hostname (quiz.johan.ml)

kubectl apply -f k8s/manifests.yaml

# Watch it come up
kubectl get pods -n quizlab -w

# Logs
kubectl logs -n quizlab -l app=quizlab -f
```

### Cloudflare Tunnel

In your Cloudflare Zero Trust dashboard, add a public hostname:

```
Hostname:  quiz.johan.ml
Service:   http://quizlab.quizlab.svc.cluster.local:80
```

WebSockets work natively through Cloudflare tunnels — no extra config needed.

---

## Scoring formula

```
Correct answer:   base_points  (default 1000, configurable per question)
Speed bonus:      up to +500, linear decay over the question's time limit
                  bonus = 500 × (1 - elapsed / time_limit)
Total per Q:      up to 1500 points
Open questions:   ±1 tolerance on numeric answers
```

---

## Host flow (on the day)

1. Open `https://quiz.johan.ml` → Host Login → enter password
2. Create or select a quiz → click **▶ Launch Game**
3. A 6-digit PIN appears — display it on a projector
4. Attendees go to `https://quiz.johan.ml`, enter the PIN, register with name + email
5. When everyone's in → **▶ Start**
6. **⏭ Next** skips the auto-timer if you want to control the pace
7. Leaderboard appears automatically every 5 questions
8. Final screen shows top 5 with gold / silver / bronze podium

---

## File structure

```
quizlab/
├── Dockerfile
├── README.md
├── backend/
│   ├── package.json
│   └── server.js          ← Express + WebSocket + SQLite
├── frontend/
│   └── public/
│       └── index.html     ← Full SPA: home / host dashboard / editor / game views
└── k8s/
    └── manifests.yaml     ← Namespace, Secret, PVC, Deployment, Service, Ingress
```

---

## Changing the host password

Edit the Secret in `k8s/manifests.yaml` and re-apply:

```bash
kubectl patch secret quizlab-secret -n quizlab \
  --type=merge -p '{"stringData":{"HOST_PASSWORD":"yournewpassword"}}'
kubectl rollout restart deployment/quizlab -n quizlab
```

---

## License

MIT — do whatever you want with it.
