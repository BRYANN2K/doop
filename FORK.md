# Fork Doop — `BRYANN2K/doop`, branche `bryan/main`

Fork de `kgoedecke/doop` (AGPL-3.0) axé sur la navigation et les performances
des très grands canvases (5000+ frames), plus une poignée de fiabilisations et
de fonctionnalités. Chaque PR upstream est mergée individuellement, avec ses
conflits résolus à la main pour préserver l'intention de chaque côté.

## PRs mergées

### Performance (canvas / zoom)

| PR   | Objet                                                                                                                                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #412 | Chargement différé du HTML des frames par page + culling des frames hors écran (les iframes hors vue sont démontées et remplacées par des placeholders).                                                              |
| #314 | Level-of-detail : budget de frames « live », les autres passent en image serveur (`frameLod.ts`, `useFrameLods`). Intégré par-dessus le culling de #412 : `live`/`image`/`none` remplace le binaire live/placeholder. |
| #434 | Optimisation du rendu pendant le zoom.                                                                                                                                                                                |
| #435 | Lecture de la bounding box du stage une fois par flush de molette (au lieu d'une par événement).                                                                                                                      |
| #436 | Optimisation zoom/pan complémentaire.                                                                                                                                                                                 |
| #437 | Les variables CSS caméra sont écrites sur le nœud qui les lit (`world`), pas sur le stage ; `--zoom` reste exposé aux règles/guides via une enveloppe `display:contents`.                                             |
| #439 | N'invalide plus le style de toute la page à chaque pas de pan.                                                                                                                                                        |

### Fiabilité

| PR   | Objet                                                                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #399 | Récupération du renderer Chromium « wedged » (relaunch + retry). Fusionné dans l'API généralisée `createRenderer`/`withPage` de #456 ; son test dédié a été retiré, `tests/renderBrowser.test.ts` couvrant les mêmes scénarios. |
| #456 | Renderer durci : navigateur distant, page leases, files d'attente, limites de pixels et de concurrence (`renderLimits.ts`, fusion de `renderLimit.ts`), `/healthz/renderer`.                                                    |
| #277 | `edit_frame_source` : remplacement littéral dans le HTML des frames. L'helper `editFrameSource` existant a été conservé ; le test de la PR est ajouté.                                                                          |
| #390 | Correctif fiabilité complémentaire.                                                                                                                                                                                             |
| #505 | Durcissement : CSP des frames, conteneur non-root, écritures contrôlées.                                                                                                                                                        |

### Fonctionnalités

| PR   | Objet                                                                              |
| ---- | ---------------------------------------------------------------------------------- |
| #462 | Couper (⌘X) frames et calques, presse-papiers canvas partagé.                      |
| #476 | Placement d'images : taille native côté serveur, endpoint HTTP d'upload/placement. |
| #457 | OpenCode dans le sélecteur « Connect AI » (brand mark + icône).                    |
| #506 | Synchronisation des feuilles de style externes dans les frames (sync CSS).         |

## PRs abandonnées

| PR   | Raison                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #299 | Ancienne implémentation de la bibliothèque de composants (~10k lignes), écrite avant qu'upstream ne livre la sienne (`componentActions`, `componentEngine`, `componentTools`, `ComponentsPanel`, migration `0052_components.sql`). La merger supprimerait l'implémentation actuelle et grefferait un second système parallèle (API serveur, panneaux, i18n). Conflit structurel non résolvable proprement — abandonnée conformément au brief. |

## Resynchroniser avec upstream

```bash
git fetch upstream
git checkout bryan/main
git merge upstream/main
# résoudre les conflits en gardant les intentions ci-dessus, puis :
bun install && bun run typecheck && bun run lint && bun run test
git push origin bryan/main   # jamais vers upstream
```

## Image Docker

Buildée en CI (`.github/workflows/docker.yml`) et publiée sur
`ghcr.io/bryann2k/doop:bryan-main` à chaque push sur `bryan/main`.

## Déploiement k3s (Tailscale only)

Manifests dans `deploy/k3s/`. Le Service reste `ClusterIP` ; l'exposition se
fait exclusivement via Tailscale Serve côté hôte. Pas d'ingress, pas de
cloudflared, pas de Funnel.

Instance déployée : `https://bryann2k-infra-prod.tail35c61f.ts.net:8850`
(Serve :8850 → `svc/doop` ClusterIP :4400, tailnet only).

```bash
# 0) vérifier le disque (>= 3 Go libres)
df -h /

# 1) namespace + Postgres + app
kubectl apply -f deploy/k3s/namespace.yaml

# 2) secrets (jamais dans le repo)
DB_PASS=$(openssl rand -hex 16)
kubectl -n doop create secret generic doop-secrets \
  --from-literal=POSTGRES_PASSWORD="$DB_PASS" \
  --from-literal=DATABASE_URL="postgres://doop:$DB_PASS@postgres.doop.svc.cluster.local:5432/doop" \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  --from-literal=BETTER_AUTH_URL="https://bryann2k-infra-prod.tail35c61f.ts.net:8850" \
  --from-literal=SIGNUP_EMAIL_DOMAINS=""   # ouvert ; à restreindre après le 1er compte

kubectl apply -f deploy/k3s/postgres.yaml -f deploy/k3s/doop.yaml
kubectl -n doop rollout status deploy/doop

# 3) exposition Tailscale Serve (sur l'hôte, comme les autres services)
tailscale serve --bg --https=8850 http://$(kubectl -n doop get svc doop -o jsonpath='{.spec.clusterIP}'):4400

# 4) vérifs
curl -sk https://bryann2k-infra-prod.tail35c61f.ts.net:8850/healthz
curl -sk https://bryann2k-infra-prod.tail35c61f.ts.net:8850/mcp   # 405 = endpoint MCP présent (POST only)
```

### Image GHCR

Le package `ghcr.io/bryann2k/doop` est **public** : le cluster le tire
directement (`imagePullPolicy: Always`). Au premier déploiement, le package
était encore privé (défaut GHCR) et l'image avait été importée à la main dans
containerd — si cela devait se reproduire :

```bash
docker build --platform linux/amd64 -t ghcr.io/bryann2k/doop:bryan-main .
docker save ghcr.io/bryann2k/doop:bryan-main | gzip > doop-image.tar.gz
scp doop-image.tar.gz <vps>:/tmp/
ssh <vps> 'sudo k3s ctr -n k8s.io images import /tmp/doop-image.tar.gz'
```

## Live instance (2026-11-12)

- URL (tailnet only): https://bryann2k-infra-prod.tail35c61f.ts.net:8850
- MCP: https://bryann2k-infra-prod.tail35c61f.ts.net:8850/mcp
- Exposure: `tailscale serve --bg --https=8850 http://<doop ClusterIP>:4400` on bryann2k-infra. No Funnel, no cloudflared.
- k3s namespace `doop`: `postgres-0` + `deploy/doop` (image `ghcr.io/bryann2k/doop:bryan-main`, public).
- Dropped PR: #299 (component library). It would have added a second, parallel component system.
