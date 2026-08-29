#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import os from 'os';

const program = new Command();

program
  .name('supremo')
  .description('Supremo CLI and MCP Server for AI Agents')
  .version('1.0.0');

program
  .command('link')
  .description('Link this folder to your Claude Desktop via MCP')
  .argument('<projectId>', 'The Supremo Project ID')
  .action((projectId) => {
    const cwd = process.cwd();
    
    // Save project config locally
    fs.writeFileSync(path.join(cwd, '.supremo.json'), JSON.stringify({ projectId }, null, 2));
    
    console.log(`🔗 Project ${projectId} linked locally.`);

    // Auto-configure Claude Desktop
    const claudeConfigPath = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    let config: any = { mcpServers: {} };
    if (fs.existsSync(claudeConfigPath)) {
      try {
        config = JSON.parse(fs.readFileSync(claudeConfigPath, 'utf8'));
      } catch(e) {}
    }
    if (!config.mcpServers) config.mcpServers = {};
    
    // Point it to run the local package
    config.mcpServers['supremo-mcp'] = {
      command: "node",
      args: [path.join(__dirname, 'index.js')]
    };
    
    fs.mkdirSync(path.dirname(claudeConfigPath), { recursive: true });
    fs.writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2));
    
    console.log(`✅ Claude Desktop Configured! Restart your Claude Desktop app.`);
    console.log(`🧠 Try asking Claude: "Qual o status da minha conexão com o Supremo?"`);
  });

program
  .command('mcp')
  .description('Run the MCP server (called automatically by Claude)')
  .action(() => {
    require('./index.js');
  });

program.parse();
