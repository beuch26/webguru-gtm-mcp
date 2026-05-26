#!/usr/bin/env node
/**
 * Wrapper de démarrage du MCP Google Tag Manager.
 * À chaque lancement par Claude Desktop :
 *  1. Détecte un projet Web Guru avec GTM connecté (le plus récent par défaut)
 *  2. Écrit .env avec les credentials à jour
 *  3. Lance index.js (le vrai MCP)
 *
 * Le MCP gère ensuite lui-même le refresh des access tokens à chaque appel
 * (les tokens GTM ont une durée de vie courte de 1h).
 */

import { createClient } from '@supabase/supabase-js';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Charge les credentials depuis .env (gitignoré). Si absent, le wrapper
// échoue avec un message clair pour éviter de les hardcoder dans le code.
dotenv.config({ path: join(__dirname, '.env') });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('[GTM MCP wrapper] ❌ Credentials manquants. Crée un fichier .env basé sur .env.example :');
  console.error('  SUPABASE_URL=https://xxx.supabase.co');
  console.error('  SUPABASE_SERVICE_KEY=eyJ...');
  console.error('  GOOGLE_CLIENT_ID=...apps.googleusercontent.com');
  console.error('  GOOGLE_CLIENT_SECRET=GOCSPX-...');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function log(...args) {
  console.error('[GTM MCP wrapper]', ...args);
}

/**
 * Cherche le projet Web Guru le plus récemment configuré avec GTM.
 * Sert juste à initialiser un default — l'utilisateur peut changer via set_project.
 */
async function pickDefaultProject() {
  try {
    const { data: integrations, error } = await supabase
      .from('project_integrations')
      .select('project_id, settings, updated_at')
      .eq('integration_type', 'googleTagManager')
      .eq('is_connected', true)
      .order('updated_at', { ascending: false })
      .limit(1);

    if (error) throw new Error(error.message);
    if (!integrations?.length) return null;

    const int = integrations[0];
    return {
      projectId: int.project_id,
      containerId: int.settings?.containerId,
      containerName: int.settings?.containerName,
      publicId: int.settings?.publicId,
      updatedAt: int.updated_at,
    };
  } catch (err) {
    log(`⚠️  Détection du projet par défaut échouée : ${err.message}`);
    return null;
  }
}

async function refreshCredentials() {
  // Lire un éventuel GTM_PROJECT_ID déjà présent (override manuel)
  const envPath = join(__dirname, '.env');
  let manualProjectId = '';
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    const match = content.match(/^GTM_PROJECT_ID=(.+)$/m);
    if (match && match[1].trim()) manualProjectId = match[1].trim();
  }

  let projectId = manualProjectId;
  let info = null;

  if (!projectId) {
    info = await pickDefaultProject();
    projectId = info?.projectId || '';
  }

  const envContent = `# Auto-généré par start-mcp.js — ${new Date().toISOString()}
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY}
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
GTM_PROJECT_ID=${projectId}
`;
  writeFileSync(envPath, envContent);

  if (info) {
    log(`✅ Projet par défaut : ${projectId}`);
    log(`   Container : ${info.containerName || '?'} (${info.publicId || info.containerId || '?'})`);
    log(`   Dernière config : ${new Date(info.updatedAt).toLocaleString('fr-FR')}`);
  } else if (manualProjectId) {
    log(`✅ Projet par défaut (manuel) : ${manualProjectId}`);
  } else {
    log('⚠️  Aucun projet GTM connecté trouvé. Utilise set_project une fois lancé.');
  }
}

async function main() {
  await refreshCredentials();

  log('🚀 Démarrage du MCP Tag Manager...');
  const mcp = spawn(process.execPath, [join(__dirname, 'index.js')], {
    stdio: 'inherit',
    env: process.env,
  });

  mcp.on('close', (code) => {
    log(`MCP terminé avec code ${code}`);
    process.exit(code ?? 0);
  });

  process.on('SIGINT', () => mcp.kill('SIGINT'));
  process.on('SIGTERM', () => mcp.kill('SIGTERM'));
}

main().catch((err) => {
  log('Erreur fatale :', err.message);
  process.exit(1);
});
