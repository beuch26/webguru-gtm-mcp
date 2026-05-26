# webguru-gtm

MCP Google Tag Manager pour Claude Desktop — écosystème Web Guru.

## À quoi ça sert

Permet à Claude de lire et écrire dans un container Google Tag Manager d'un
projet Web Guru, sans passer par l'UI Google. Cas d'usage type :

> *"Crée une conversion 'Inscription' pour AgentCo, déclencheur page
> /immobilier/bienvenue/agent-commercial, et lie-la à ma campagne SEARCH."*

Claude :
1. `set_project(...)` pour basculer sur AgentCo
2. `create_pageview_trigger(...)` → triggerId
3. `create_ads_conversion_tag(...)` avec le triggerId + conversion_id/label venant de Google Ads
4. `publish_workspace(...)` → live sur le site

## Prérequis côté Web Guru

1. Le projet doit avoir Google connecté **avec les scopes tagmanager.\*** (en pratique :
   après le déploiement de la v0.1, l'utilisateur doit cliquer "Déconnecter tout"
   puis se reconnecter pour récupérer les nouveaux scopes).
2. Un container GTM doit être sélectionné dans Paramètres > Intégrations > Tag Manager.
3. L'API Tag Manager v2 doit être activée sur le projet GCP qui héberge le OAuth client.

## Lancement

Le MCP est lancé automatiquement par Claude Desktop via la config :

```json
"webguru-gtm": {
  "command": "node",
  "args": ["C:\\Users\\Matthieu\\mcp-servers\\webguru-gtm\\start-mcp.js"]
}
```

`start-mcp.js` détecte au boot le projet GTM connecté le plus récent et l'utilise
comme projet par défaut. L'utilisateur peut basculer à tout moment via `set_project`.

## Architecture

Identique au MCP `webguru-sea` :
- Lit `project_integrations.settings` (container choisi) et `oauth_tokens` (token Google)
  **directement depuis Supabase** avec le service key
- Refresh les access tokens à la volée (1h de durée de vie)
- Appelle l'API Tag Manager v2 (`tagmanager.googleapis.com/tagmanager/v2`)

Pas de passage par `api.web-guru.fr`.

## Tools

| Tool | Description |
|------|-------------|
| `set_project` | Bascule sur un autre projet Web Guru |
| `get_current_project` | Projet courant + container GTM |
| `list_accounts` | Comptes GTM accessibles |
| `list_containers` | Conteneurs d'un compte |
| `list_workspaces` | Workspaces d'un conteneur |
| `list_tags` | Balises du workspace courant |
| `list_triggers` | Déclencheurs du workspace courant |
| `list_variables` | Variables custom + built-in actives |
| `create_pageview_trigger` | Déclencheur Page Vue filtré sur URL |
| `create_ads_conversion_tag` | Balise Google Ads Conversion Tracking (awct) |
| `publish_workspace` | Crée une version + publie (live) |

## Pièges connus

- **Enable Conversion Linker = true par défaut** sur `create_ads_conversion_tag` —
  obligatoire pour préserver le `gclid` first-party (cookieless tracking). Ne désactive
  jamais sans raison.
- **Publish = action live**. Toutes les modifs en cours du workspace deviennent actives
  sur le site immédiatement. Pas de mode preview/staging dans ce MCP (v0.1).
- **Default Workspace partagé** : si un humain édite le même workspace en parallèle
  pendant qu'on push, conflit possible. Pour la v0.1, on se contente du Default
  Workspace (un workspace dédié "Web Guru MCP" est prévu pour la v0.2).
- **Concurrent edits** : la version créée capture l'état du workspace au moment du
  publish, pas avant. Si une modif tierce arrive entre `create_pageview_trigger` et
  `publish_workspace`, elle sera publiée avec.
