export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export interface Database {
  public: {
    Tables: {
      github_accounts: {
        Row: {
          id: string
          user_id: string
          github_user_id: number
          login: string
          name: string | null
          avatar_url: string | null
          access_token_encrypted: string
          refresh_token_encrypted: string | null
          token_expires_at: string | null
          scopes: string[]
          created_at: string
          updated_at: string
        }
        Insert: Omit<
          Database['public']['Tables']['github_accounts']['Row'],
          'id' | 'created_at' | 'updated_at' | 'token_expires_at'
        > & { token_expires_at?: string | null }
        Update: Partial<
          Database['public']['Tables']['github_accounts']['Insert']
        >
      }
      supabase_accounts: {
        Row: {
          id: string
          user_id: string
          org_name: string
          org_slug: string
          access_token_encrypted: string
          refresh_token_encrypted: string | null
          token_expires_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: Omit<
          Database['public']['Tables']['supabase_accounts']['Row'],
          'id' | 'created_at' | 'updated_at' | 'token_expires_at'
        > & { token_expires_at?: string | null }
        Update: Partial<
          Database['public']['Tables']['supabase_accounts']['Insert']
        >
      }
      secret_requests: {
        Row: {
          id: string
          project_id: string
          user_id: string
          name: string
          description: string | null
          is_secret: boolean
          status: 'pending' | 'fulfilled'
          created_at: string
          fulfilled_at: string | null
        }
        Insert: {
          id?: string
          project_id: string
          user_id: string
          name: string
          description?: string | null
          is_secret?: boolean
          status?: 'pending' | 'fulfilled'
          created_at?: string
          fulfilled_at?: string | null
        }
        Update: Partial<
          Database['public']['Tables']['secret_requests']['Insert']
        >
      }
      projects: {
        Row: {
          id: string
          user_id: string
          name: string
          description: string | null
          github_account_id: string | null
          supabase_account_id: string | null
          github_repo_full_name: string | null
          github_repo_id: number | null
          supabase_project_ref: string | null
          cloudflare_project_name: string | null
          active_mcp: string
          active_branch: string
          preview_url: string | null
          status: 'active' | 'creating' | 'error' | 'archived'
          is_active: boolean
          db_password_encrypted: string | null
          vercel_project_id: string | null
          default_branch: string
          template_version: string | null
          vercel_account_id: string | null
          production_url: string | null
          preview_project_name: string | null
          preview_url_shared: string | null
          preview_updated_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: Omit<
          Database['public']['Tables']['projects']['Row'],
          'id' | 'created_at' | 'updated_at'
        >
        Update: Partial<Database['public']['Tables']['projects']['Insert']>
      }
      messages: {
        Row: {
          id: string
          project_id: string
          user_id: string
          role: 'user' | 'assistant'
          content: string
          commit_sha: string | null
          commit_message: string | null
          files_changed: Json | null
          pipeline_status: 'pending' | 'running' | 'passed' | 'failed' | null
          pipeline_log: Json | null
          mcp_used: string | null
          branch: string | null
          pr_number: number | null
          pr_url: string | null
          checks_url: string | null
          preview_url: string | null
          created_at: string
        }
        Insert: Omit<
          Database['public']['Tables']['messages']['Row'],
          'id' | 'created_at'
        >
        Update: Partial<Database['public']['Tables']['messages']['Insert']>
      }
      mcp_tokens: {
        Row: {
          id: string
          user_id: string
          name: string
          token_hash: string
          token_prefix: string
          last_used_at: string | null
          expires_at: string | null
          revoked_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: Omit<
          Database['public']['Tables']['mcp_tokens']['Row'],
          'id' | 'created_at' | 'updated_at'
        >
        Update: Partial<Database['public']['Tables']['mcp_tokens']['Insert']>
      }
      oauth_states: {
        Row: {
          id: string
          user_id: string
          state: string
          provider: 'github' | 'supabase' | 'vercel'
          project_id: string | null
          redirect_to: string | null
          consumed_at: string | null
          expires_at: string
          created_at: string
        }
        Insert: Omit<
          Database['public']['Tables']['oauth_states']['Row'],
          'id' | 'created_at'
        >
        Update: Partial<Database['public']['Tables']['oauth_states']['Insert']>
      }
      vercel_accounts: {
        Row: {
          id: string
          user_id: string
          account_name: string
          team_id: string | null
          access_token_encrypted: string
          created_at: string
          updated_at: string
        }
        Insert: Omit<
          Database['public']['Tables']['vercel_accounts']['Row'],
          'id' | 'created_at' | 'updated_at'
        >
        Update: Partial<
          Database['public']['Tables']['vercel_accounts']['Insert']
        >
      }
      mcp_configs: {
        Row: {
          id: string
          user_id: string
          name: string
          type: 'antigravity' | 'claude' | 'openai' | 'custom'
          endpoint_url: string | null
          api_key_encrypted: string | null
          is_active: boolean
          created_at: string
          updated_at: string
        }
        Insert: Omit<
          Database['public']['Tables']['mcp_configs']['Row'],
          'id' | 'created_at' | 'updated_at'
        >
        Update: Partial<Database['public']['Tables']['mcp_configs']['Insert']>
      }
      audit_logs: {
        Row: {
          id: string
          user_id: string
          action: string
          resource_type: string
          resource_id: string | null
          metadata: Json | null
          ip_address: string | null
          created_at: string
        }
        Insert: Omit<
          Database['public']['Tables']['audit_logs']['Row'],
          'id' | 'created_at'
        >
        Update: never
      }
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
  }
}

// Convenience types
export type GithubAccount =
  Database['public']['Tables']['github_accounts']['Row']
export type SupabaseAccount =
  Database['public']['Tables']['supabase_accounts']['Row']
export type Project = Database['public']['Tables']['projects']['Row']
export type Message = Database['public']['Tables']['messages']['Row']
export type McpConfig = Database['public']['Tables']['mcp_configs']['Row']
export type AuditLog = Database['public']['Tables']['audit_logs']['Row']
export type McpToken = Database['public']['Tables']['mcp_tokens']['Row']
export type OAuthState = Database['public']['Tables']['oauth_states']['Row']
export type VercelAccount =
  Database['public']['Tables']['vercel_accounts']['Row']
