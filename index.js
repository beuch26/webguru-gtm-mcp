#!/usr/bin/env node
/**
 * MCP Google Tag Manager pour Claude Desktop — Web Guru
 *
 * Lit la config GTM d'un projet Web Guru depuis Supabase
 * (project_integrations + oauth_tokens), puis appelle l'API Tag Manager v2.
 *
 * Tools exposés :
 *  - Context : set_project, get_current_project
 *  - Reads   : list_accounts, list_containers, list_workspaces,
 *              list_tags, list_triggers, list_variables
 *  - Writes  : create_pageview_trigger, create_ads_conversion_tag,
 *              publish_workspace
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: join(__dirname, '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_URL et SUPABASE_SERVICE_KEY requis dans .env');
  process.exit(1);
}
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('❌ GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET requis dans .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Contexte courant (modifiable via set_project)
let currentProjectId = process.env.GTM_PROJECT_ID || null;
let currentContext = null; // { accountId, containerId, containerName, publicId, workspaceId, workspaceName, projectName }

const GTM_API_BASE = 'https://tagmanager.googleapis.com/tagmanager/v2';

// ───────────────────────────────────────────────────────────────────────────
// SUPABASE : lire le projet + le token
// ───────────────────────────────────────────────────────────────────────────

async function loadProjectContext(projectId) {
  // 1. Nom du projet + user_id
  const { data: project, error: projectError } = await supabase
    .from('projects')
    .select('id, name, user_id')
    .eq('id', projectId)
    .single();
  if (projectError || !project) {
    throw new Error(`Projet introuvable : ${projectId}`);
  }

  // 2. Config GTM (account/container/workspace sélectionnés)
  const { data: integration, error: integrationError } = await supabase
    .from('project_integrations')
    .select('settings, is_connected')
    .eq('project_id', projectId)
    .eq('integration_type', 'googleTagManager')
    .maybeSingle();

  if (integrationError) {
    throw new Error(`Erreur lecture project_integrations : ${integrationError.message}`);
  }

  const settings = integration?.settings || {};
  return {
    projectId,
    projectName: project.name,
    userId: project.user_id,
    isConnected: integration?.is_connected || false,
    accountId: settings.accountId || null,
    accountName: settings.accountName || null,
    containerId: settings.containerId || null,
    containerName: settings.containerName || null,
    publicId: settings.publicId || null,
    workspaceId: settings.workspaceId || null,
    workspaceName: settings.workspaceName || null,
  };
}

async function getGtmAccessToken(projectId) {
  const ctx = await loadProjectContext(projectId);

  // Tente d'abord le token dédié 'google-tag-manager'
  const services = ['google-tag-manager', 'google-ads', 'google-business', 'google-analytics', 'google-search-console'];
  let tokenRow = null;
  let usedService = null;

  for (const service of services) {
    const { data: tokens, error } = await supabase.rpc('get_oauth_token', {
      p_user_id: ctx.userId,
      p_project_id: projectId,
      p_service_type: service,
      p_service_account_id: null,
    });
    if (error) continue;
    if (tokens && tokens.length > 0 && tokens[0].refresh_token) {
      tokenRow = tokens[0];
      usedService = service;
      break;
    }
  }

  if (!tokenRow) {
    throw new Error(`Aucun token Google trouvé pour le projet ${projectId}. Reconnectez Google dans les paramètres.`);
  }

  let accessToken = tokenRow.access_token;
  const isExpired =
    tokenRow.is_expired ||
    (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date(Date.now() + 60_000));

  if (isExpired && tokenRow.refresh_token) {
    console.error(`🔄 [GTM] Token ${usedService} expiré, refresh...`);
    accessToken = await refreshAccessToken(tokenRow.refresh_token);

    await supabase.rpc('save_oauth_token', {
      p_user_id: ctx.userId,
      p_project_id: projectId,
      p_service_type: 'google-tag-manager',
      p_service_account_id: 'default',
      p_access_token: accessToken,
      p_refresh_token: tokenRow.refresh_token,
      p_expires_in: 3600,
      p_scope: tokenRow.scope,
      p_metadata: tokenRow.metadata,
    });
  }

  return { accessToken, refreshToken: tokenRow.refresh_token, ctx };
}

async function refreshAccessToken(refreshToken) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Refresh token failed: ${errorText}`);
  }

  const json = await response.json();
  return json.access_token;
}

// ───────────────────────────────────────────────────────────────────────────
// GTM API HELPER
// ───────────────────────────────────────────────────────────────────────────

async function gtmApi(path, options = {}) {
  if (!currentProjectId) {
    throw new Error('Aucun projet sélectionné. Utilise set_project.');
  }

  const { accessToken } = await getGtmAccessToken(currentProjectId);

  const response = await fetch(`${GTM_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    let parsed;
    try { parsed = JSON.parse(errorBody); } catch { parsed = errorBody; }
    const err = new Error(
      parsed?.error?.message || `GTM API ${response.status}: ${errorBody}`
    );
    err.statusCode = response.status;
    err.googleError = parsed?.error;
    throw err;
  }

  if (response.status === 204) return null;
  return response.json();
}

function workspacePath(ctx) {
  if (!ctx.accountId || !ctx.containerId || !ctx.workspaceId) {
    throw new Error(
      'Configuration GTM incomplète pour ce projet. Sélectionne le container dans Web Guru (Paramètres > Intégrations > Tag Manager) ou réessaie après reconnexion Google.'
    );
  }
  return `/accounts/${ctx.accountId}/containers/${ctx.containerId}/workspaces/${ctx.workspaceId}`;
}

// ───────────────────────────────────────────────────────────────────────────
// TOOL DEFINITIONS
// ───────────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'set_project',
    description: "Change le projet Web Guru actif (et donc le container GTM associé). Utilise cet outil quand l'utilisateur veut intervenir sur un autre client/projet.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'UUID du projet Web Guru' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'get_current_project',
    description: "Affiche le projet courant et le container GTM associé (compte, container, workspace).",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_accounts',
    description: 'Liste les comptes Google Tag Manager accessibles par le compte Google connecté au projet.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_containers',
    description: "Liste les conteneurs d'un compte GTM.",
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'accountId GTM (optionnel, utilise celui du projet courant si non fourni)' },
      },
    },
  },
  {
    name: 'list_workspaces',
    description: "Liste les workspaces d'un container GTM.",
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'accountId (optionnel, par défaut celui du projet)' },
        container_id: { type: 'string', description: 'containerId (optionnel, par défaut celui du projet)' },
      },
    },
  },
  {
    name: 'list_tags',
    description: 'Liste toutes les balises (tags) du workspace courant.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_triggers',
    description: 'Liste tous les déclencheurs (triggers) du workspace courant.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_variables',
    description: 'Liste les variables (custom + built-in actives) du workspace courant.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'create_pageview_trigger',
    description: "Crée un déclencheur Page Vue filtré sur une URL (utilisé pour tracker une page de remerciement / confirmation).",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nom du déclencheur. Ex: "PV - Bienvenue Mandataire Immo"' },
        filter_url: { type: 'string', description: 'Valeur à matcher dans Page Path ou Page URL. Ex: "/immobilier/bienvenue/agent-commercial"' },
        filter_type: {
          type: 'string',
          description: 'Type de matching (défaut: EQUALS)',
          enum: ['EQUALS', 'CONTAINS', 'MATCHES_REGEX', 'STARTS_WITH', 'ENDS_WITH'],
        },
        filter_target: {
          type: 'string',
          description: 'Variable à filtrer (défaut: PAGE_PATH plus robuste, PAGE_URL inclut query string)',
          enum: ['PAGE_PATH', 'PAGE_URL'],
        },
      },
      required: ['name', 'filter_url'],
    },
  },
  {
    name: 'create_ads_conversion_tag',
    description: "Crée une balise Google Ads Conversion Tracking (type 'awct'), attachée à un déclencheur existant. Le Conversion Linker est activé par défaut (obligatoire pour préserver les gclid first-party).",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nom de la balise. Ex: "GAds - Conv Inscription Mandataire Immo"' },
        conversion_id: { type: 'string', description: "Conversion ID Google Ads (la partie après AW- dans AW-XXXXXXXXX)" },
        conversion_label: { type: 'string', description: 'Label de conversion (chaîne unique par action, fourni par Ads)' },
        trigger_id: { type: 'string', description: "triggerId du déclencheur à attacher (depuis create_pageview_trigger ou list_triggers)" },
        conversion_value: { type: 'number', description: 'Valeur monétaire fixe de la conversion (optionnel)' },
        currency_code: { type: 'string', description: 'Code devise ISO (défaut: EUR)' },
        enable_conversion_linker: { type: 'boolean', description: 'Activer Conversion Linker (défaut: true, NE PAS désactiver sans raison)' },
      },
      required: ['name', 'conversion_id', 'conversion_label', 'trigger_id'],
    },
  },
  {
    name: 'publish_workspace',
    description: "Publie le workspace courant : crée une nouvelle version puis la publie. ⚠️ Action live — toutes les modifs en cours deviennent actives sur le site immédiatement.",
    inputSchema: {
      type: 'object',
      properties: {
        version_name: { type: 'string', description: "Nom de la version (défaut: 'Auto-publish from Web Guru MCP {timestamp}')" },
        version_notes: { type: 'string', description: 'Notes de version (optionnel)' },
      },
    },
  },
];

// ───────────────────────────────────────────────────────────────────────────
// TOOL HANDLERS
// ───────────────────────────────────────────────────────────────────────────

async function handleSetProject(args) {
  const newProjectId = args.project_id;
  if (!newProjectId) throw new Error('project_id requis');

  const ctx = await loadProjectContext(newProjectId);
  currentProjectId = newProjectId;
  currentContext = ctx;

  return {
    success: true,
    project: {
      id: ctx.projectId,
      name: ctx.projectName,
    },
    gtm: ctx.isConnected
      ? {
          account: { id: ctx.accountId, name: ctx.accountName },
          container: { id: ctx.containerId, name: ctx.containerName, publicId: ctx.publicId },
          workspace: { id: ctx.workspaceId, name: ctx.workspaceName },
        }
      : null,
    warning: ctx.isConnected ? null : 'Aucun container GTM sélectionné pour ce projet. Configure-le dans Web Guru > Paramètres > Intégrations.',
  };
}

async function handleGetCurrentProject() {
  if (!currentProjectId) {
    return { success: false, error: 'Aucun projet sélectionné. Utilise set_project.' };
  }
  const ctx = await loadProjectContext(currentProjectId);
  currentContext = ctx;
  return {
    success: true,
    project: { id: ctx.projectId, name: ctx.projectName },
    gtm: ctx.isConnected
      ? {
          account: { id: ctx.accountId, name: ctx.accountName },
          container: { id: ctx.containerId, name: ctx.containerName, publicId: ctx.publicId },
          workspace: { id: ctx.workspaceId, name: ctx.workspaceName },
        }
      : null,
  };
}

async function handleListAccounts() {
  const data = await gtmApi('/accounts');
  return {
    success: true,
    accounts: (data?.account || []).map((a) => ({
      accountId: a.accountId,
      name: a.name,
      path: a.path,
    })),
  };
}

async function handleListContainers(args) {
  const ctx = currentContext || (currentProjectId ? await loadProjectContext(currentProjectId) : null);
  const accountId = args.account_id || ctx?.accountId;
  if (!accountId) throw new Error('account_id requis (ou container GTM non sélectionné pour le projet)');

  const data = await gtmApi(`/accounts/${accountId}/containers`);
  return {
    success: true,
    containers: (data?.container || []).map((c) => ({
      containerId: c.containerId,
      name: c.name,
      publicId: c.publicId,
      domainName: c.domainName || [],
      path: c.path,
      usageContext: c.usageContext || [],
    })),
  };
}

async function handleListWorkspaces(args) {
  const ctx = currentContext || (currentProjectId ? await loadProjectContext(currentProjectId) : null);
  const accountId = args.account_id || ctx?.accountId;
  const containerId = args.container_id || ctx?.containerId;
  if (!accountId || !containerId) throw new Error('account_id et container_id requis (ou GTM non sélectionné pour le projet)');

  const data = await gtmApi(`/accounts/${accountId}/containers/${containerId}/workspaces`);
  return {
    success: true,
    workspaces: (data?.workspace || []).map((w) => ({
      workspaceId: w.workspaceId,
      name: w.name,
      description: w.description,
      path: w.path,
    })),
  };
}

async function handleListTags() {
  const ctx = await loadProjectContext(currentProjectId);
  currentContext = ctx;
  const wsPath = workspacePath(ctx);
  const data = await gtmApi(`${wsPath}/tags`);
  return {
    success: true,
    workspace: { name: ctx.workspaceName, id: ctx.workspaceId },
    tags: (data?.tag || []).map((t) => ({
      tagId: t.tagId,
      name: t.name,
      type: t.type,
      paused: t.paused || false,
      firingTriggerId: t.firingTriggerId || [],
      blockingTriggerId: t.blockingTriggerId || [],
      parameter: t.parameter || [],
    })),
  };
}

async function handleListTriggers() {
  const ctx = await loadProjectContext(currentProjectId);
  currentContext = ctx;
  const wsPath = workspacePath(ctx);
  const data = await gtmApi(`${wsPath}/triggers`);
  return {
    success: true,
    workspace: { name: ctx.workspaceName, id: ctx.workspaceId },
    triggers: (data?.trigger || []).map((t) => ({
      triggerId: t.triggerId,
      name: t.name,
      type: t.type,
      filter: t.filter || [],
    })),
  };
}

async function handleListVariables() {
  const ctx = await loadProjectContext(currentProjectId);
  currentContext = ctx;
  const wsPath = workspacePath(ctx);

  // Variables custom du workspace
  const customData = await gtmApi(`${wsPath}/variables`);

  // Variables built-in actives sur le container
  const containerPath = `/accounts/${ctx.accountId}/containers/${ctx.containerId}`;
  const builtInData = await gtmApi(`${wsPath}/built_in_variables`);

  return {
    success: true,
    workspace: { name: ctx.workspaceName, id: ctx.workspaceId },
    custom_variables: (customData?.variable || []).map((v) => ({
      variableId: v.variableId,
      name: v.name,
      type: v.type,
    })),
    built_in_variables_enabled: (builtInData?.builtInVariable || []).map((v) => ({
      name: v.name,
      type: v.type,
    })),
  };
}

async function handleCreatePageViewTrigger(args) {
  const ctx = await loadProjectContext(currentProjectId);
  currentContext = ctx;
  const wsPath = workspacePath(ctx);

  const filterType = (args.filter_type || 'EQUALS').toLowerCase(); // GTM accepte "equals", "contains", etc.
  const filterTarget = args.filter_target || 'PAGE_PATH';
  const targetVar = filterTarget === 'PAGE_URL' ? '{{Page URL}}' : '{{Page Path}}';

  // S'assurer que la built-in variable est activée
  const builtInName = filterTarget === 'PAGE_URL' ? 'pageUrl' : 'pagePath';
  try {
    await gtmApi(`${wsPath}/built_in_variables?type=${builtInName}`, { method: 'POST' });
  } catch (e) {
    // Si déjà activée, GTM renvoie 409 — on ignore
    if (e.statusCode !== 409) {
      console.error(`⚠️ [GTM] Activation built-in variable ${builtInName} échouée: ${e.message}`);
    }
  }

  const triggerResource = {
    name: args.name,
    type: 'pageview',
    filter: [
      {
        type: filterType,
        parameter: [
          { type: 'template', key: 'arg0', value: targetVar },
          { type: 'template', key: 'arg1', value: args.filter_url },
        ],
      },
    ],
  };

  const data = await gtmApi(`${wsPath}/triggers`, {
    method: 'POST',
    body: JSON.stringify(triggerResource),
  });

  return {
    success: true,
    trigger: {
      triggerId: data.triggerId,
      name: data.name,
      type: data.type,
      filter: data.filter,
    },
    message: `Déclencheur "${data.name}" créé (triggerId: ${data.triggerId}). N'oublie pas de publier le workspace pour activer.`,
  };
}

async function handleCreateAdsConversionTag(args) {
  const ctx = await loadProjectContext(currentProjectId);
  currentContext = ctx;
  const wsPath = workspacePath(ctx);

  const parameters = [
    { type: 'template', key: 'conversionId', value: String(args.conversion_id) },
    { type: 'template', key: 'conversionLabel', value: String(args.conversion_label) },
    {
      type: 'boolean',
      key: 'enableConversionLinker',
      value: args.enable_conversion_linker === false ? 'false' : 'true',
    },
  ];

  if (typeof args.conversion_value === 'number') {
    parameters.push({ type: 'template', key: 'conversionValue', value: String(args.conversion_value) });
  }
  if (args.currency_code) {
    parameters.push({ type: 'template', key: 'conversionCurrency', value: String(args.currency_code) });
  } else if (typeof args.conversion_value === 'number') {
    parameters.push({ type: 'template', key: 'conversionCurrency', value: 'EUR' });
  }

  const tagResource = {
    name: args.name,
    type: 'awct',
    parameter: parameters,
    firingTriggerId: [String(args.trigger_id)],
  };

  const data = await gtmApi(`${wsPath}/tags`, {
    method: 'POST',
    body: JSON.stringify(tagResource),
  });

  return {
    success: true,
    tag: {
      tagId: data.tagId,
      name: data.name,
      type: data.type,
      firingTriggerId: data.firingTriggerId,
    },
    message: `Balise "${data.name}" créée (tagId: ${data.tagId}). Publie le workspace pour activer.`,
  };
}

async function handlePublishWorkspace(args) {
  const ctx = await loadProjectContext(currentProjectId);
  currentContext = ctx;
  const wsPath = workspacePath(ctx);

  const versionName = args.version_name || `Auto-publish from Web Guru MCP ${new Date().toISOString()}`;
  const versionNotes = args.version_notes || `Publié via MCP webguru-gtm depuis le projet "${ctx.projectName}"`;

  // Étape 1 : créer une version depuis le workspace
  console.error(`📦 [GTM] Création version pour workspace ${ctx.workspaceId}...`);
  const versionData = await gtmApi(`${wsPath}:create_version`, {
    method: 'POST',
    body: JSON.stringify({ name: versionName, notes: versionNotes }),
  });

  const version = versionData?.containerVersion;
  if (!version?.containerVersionId) {
    throw new Error(`Création de version échouée : ${JSON.stringify(versionData)}`);
  }

  const versionId = version.containerVersionId;
  const versionPath = `/accounts/${ctx.accountId}/containers/${ctx.containerId}/versions/${versionId}`;

  // Étape 2 : publier la version
  console.error(`🚀 [GTM] Publication version ${versionId}...`);
  let published;
  try {
    published = await gtmApi(`${versionPath}:publish`, { method: 'POST' });
  } catch (e) {
    // Version créée mais publish échoué — état partiel
    const err = new Error(`Version créée (id ${versionId}) mais publish échoué : ${e.message}`);
    err.partialState = { versionId, versionName };
    throw err;
  }

  return {
    success: true,
    version: {
      versionId,
      name: versionName,
      path: versionPath,
    },
    published_at: new Date().toISOString(),
    message: `Workspace publié en version "${versionName}". Les balises sont actives sur le site.`,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// MCP SERVER
// ───────────────────────────────────────────────────────────────────────────

const server = new Server(
  {
    name: 'webguru-gtm',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    let result;
    switch (name) {
      case 'set_project':
        result = await handleSetProject(args);
        break;
      case 'get_current_project':
        result = await handleGetCurrentProject();
        break;
      case 'list_accounts':
        result = await handleListAccounts();
        break;
      case 'list_containers':
        result = await handleListContainers(args);
        break;
      case 'list_workspaces':
        result = await handleListWorkspaces(args);
        break;
      case 'list_tags':
        result = await handleListTags();
        break;
      case 'list_triggers':
        result = await handleListTriggers();
        break;
      case 'list_variables':
        result = await handleListVariables();
        break;
      case 'create_pageview_trigger':
        result = await handleCreatePageViewTrigger(args);
        break;
      case 'create_ads_conversion_tag':
        result = await handleCreateAdsConversionTag(args);
        break;
      case 'publish_workspace':
        result = await handlePublishWorkspace(args);
        break;
      default:
        throw new Error(`Tool inconnu : ${name}`);
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    console.error(`❌ [${name}] ${error.message}`);
    const errorPayload = {
      success: false,
      tool: name,
      message: error.message || 'Erreur inconnue',
      status_code: error.statusCode,
      google_error: error.googleError,
      partial_state: error.partialState,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(errorPayload, null, 2) }],
      isError: true,
    };
  }
});

// Pré-charger le contexte du projet par défaut si défini
async function init() {
  if (currentProjectId) {
    try {
      currentContext = await loadProjectContext(currentProjectId);
      console.error(`✅ Projet par défaut chargé : ${currentContext.projectName} (${currentProjectId})`);
      console.error(`   Container : ${currentContext.containerName} (${currentContext.publicId || currentContext.containerId})`);
    } catch (e) {
      console.error(`⚠️  Impossible de charger le projet par défaut : ${e.message}`);
    }
  }
}

await init();

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('🚀 MCP webguru-gtm ready (stdio)');
