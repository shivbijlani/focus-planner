import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;

const CONFIG_PATH = path.join(__dirname, 'planner-config.json');
const DEFAULT_PLANNER_PATH = path.join(__dirname, '..', 'planner');

async function loadConfig() {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw);
    return cfg.plannerPath || DEFAULT_PLANNER_PATH;
  } catch {
    return DEFAULT_PLANNER_PATH;
  }
}

async function saveConfig(plannerPath) {
  await fs.writeFile(CONFIG_PATH, JSON.stringify({ plannerPath }, null, 2), 'utf-8');
}

// Mutable planner path (loaded from config on startup)
let PLANNER_PATH = DEFAULT_PLANNER_PATH;
loadConfig().then(p => { PLANNER_PATH = p; });

app.use(cors());
app.use(express.json());

// Get directory tree structure
async function getDirectoryTree(dirPath, relativePath = '') {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const items = [];

  for (const entry of entries) {
    // Skip hidden files and node_modules
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    const fullPath = path.join(dirPath, entry.name);
    const itemRelativePath = path.join(relativePath, entry.name);

    if (entry.isDirectory()) {
      const children = await getDirectoryTree(fullPath, itemRelativePath);
      items.push({
        name: entry.name,
        type: 'directory',
        path: itemRelativePath,
        children
      });
    } else if (entry.name.endsWith('.md')) {
      items.push({
        name: entry.name,
        type: 'file',
        path: itemRelativePath
      });
    }
  }

  return items;
}

// GET /api/files - List all markdown files and folders
app.get('/api/files', async (req, res) => {
  try {
    const tree = await getDirectoryTree(PLANNER_PATH);
    res.json(tree);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/file - Read a specific markdown file (path as query param)
app.get('/api/file', async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) {
      return res.status(400).json({ error: 'Missing path parameter' });
    }
    const fullPath = path.join(PLANNER_PATH, filePath);
    
    // Security: ensure path is within PLANNER_PATH
    if (!fullPath.startsWith(PLANNER_PATH)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const content = await fs.readFile(fullPath, 'utf-8');
    res.json({ path: filePath, content });
  } catch (error) {
    res.status(404).json({ error: 'File not found' });
  }
});

// PUT /api/file - Update a markdown file (path as query param)
app.put('/api/file', async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) {
      return res.status(400).json({ error: 'Missing path parameter' });
    }
    const fullPath = path.join(PLANNER_PATH, filePath);
    
    // Security: ensure path is within PLANNER_PATH
    if (!fullPath.startsWith(PLANNER_PATH)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { content } = req.body;
    await fs.writeFile(fullPath, content, 'utf-8');
    res.json({ success: true, path: filePath });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/file - Delete a markdown file (path as query param)
app.delete('/api/file', async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) {
      return res.status(400).json({ error: 'Missing path parameter' });
    }
    const fullPath = path.join(PLANNER_PATH, filePath);
    
    // Security: ensure path is within PLANNER_PATH
    if (!fullPath.startsWith(PLANNER_PATH)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await fs.unlink(fullPath);
    res.json({ success: true, path: filePath });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/todos - Extract todos from a journal file
app.get('/api/todos', async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) {
      return res.status(400).json({ error: 'Missing path parameter' });
    }
    const fullPath = path.join(PLANNER_PATH, filePath);
    
    // Security: ensure path is within PLANNER_PATH
    if (!fullPath.startsWith(PLANNER_PATH)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const content = await fs.readFile(fullPath, 'utf-8');
    const lines = content.split(/\r?\n/);
    
    // Find todos - look for:
    // 1. Checkbox items: - [ ] text or - [x] text
    // 2. TODO: prefix items: - TODO: text
    // 3. DONE: prefix items: - DONE: text
    const todos = [];
    
    for (const line of lines) {
      // Extract checkbox items
      const checkboxMatch = line.match(/^-\s*\[([ x])\]\s*(.+)/i);
      if (checkboxMatch) {
        todos.push({
          done: checkboxMatch[1].toLowerCase() === 'x',
          text: checkboxMatch[2].trim()
        });
        continue;
      }
      
      // Extract TODO: prefix items
      const todoMatch = line.match(/^-\s*TODO:\s*(.+)/i);
      if (todoMatch) {
        todos.push({
          done: false,
          text: todoMatch[1].trim()
        });
        continue;
      }
      
      // Extract DONE: prefix items
      const doneMatch = line.match(/^-\s*DONE:\s*(.+)/i);
      if (doneMatch) {
        todos.push({
          done: true,
          text: doneMatch[1].trim()
        });
      }
    }
    
    res.json({ path: filePath, todos });
  } catch (error) {
    res.status(404).json({ error: 'File not found', todos: [] });
  }
});

// GET /api/journal-exists - Check if a journal file exists for a task ID
app.get('/api/journal-exists', async (req, res) => {
  try {
    const taskId = req.query.taskId;
    if (!taskId) {
      return res.status(400).json({ error: 'Missing taskId parameter' });
    }
    
    const journalPath = path.join(PLANNER_PATH, 'journal', `task-${taskId}.md`);
    
    try {
      const stats = await fs.stat(journalPath);
      // Check if file is non-empty
      if (stats.size > 0) {
        res.json({ exists: true, path: `journal/task-${taskId}.md` });
      } else {
        res.json({ exists: false });
      }
    } catch {
      res.json({ exists: false });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/pick-folder - Open native Windows folder picker dialog
app.post('/api/pick-folder', (req, res) => {
  const initialDir = (req.body && req.body.initialDir) || PLANNER_PATH;
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select planner folder'
$dialog.SelectedPath = '${initialDir.replace(/'/g, "''")}'
$dialog.ShowNewFolderButton = $true
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.Size = New-Object System.Drawing.Size(1,1)
$owner.StartPosition = 'CenterScreen'
$owner.Opacity = 0
$owner.Show()
[Win]::SetForegroundWindow($owner.Handle) | Out-Null
$owner.Activate()
$result = $dialog.ShowDialog($owner)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
`;
  const ps = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
    windowsHide: false,
    detached: false,
  });
  let output = '';
  let errOutput = '';
  ps.stdout.on('data', d => { output += d.toString(); });
  ps.stderr.on('data', d => { errOutput += d.toString(); });
  ps.on('close', () => {
    const selected = output.trim();
    if (selected) {
      res.json({ selectedPath: selected });
    } else {
      res.json({ selectedPath: null, error: errOutput.trim() || null });
    }
  });
});

// GET /api/config - Get current planner folder path
app.get('/api/config', (req, res) => {
  res.json({ plannerPath: PLANNER_PATH });
});

// POST /api/config - Set planner folder path
app.post('/api/config', async (req, res) => {
  try {
    const { plannerPath } = req.body;
    if (!plannerPath) {
      return res.status(400).json({ error: 'Missing plannerPath' });
    }
    // Verify the directory exists
    try {
      const stat = await fs.stat(plannerPath);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: 'Path is not a directory' });
      }
    } catch {
      return res.status(400).json({ error: 'Directory does not exist' });
    }
    PLANNER_PATH = plannerPath;
    await saveConfig(plannerPath);
    res.json({ success: true, plannerPath });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Planner API server running at http://localhost:${PORT}`);
  console.log(`Reading markdown files from: ${PLANNER_PATH}`);
});
