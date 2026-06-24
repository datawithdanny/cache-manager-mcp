use std::collections::HashMap;

use zed_extension_api as zed;

#[derive(Default)]
struct CacheManagerSettings {
    node_path: Option<String>,
    server_path: Option<String>,
    env: HashMap<String, String>,
}

fn parse_settings(value: Option<zed::serde_json::Value>) -> zed::Result<CacheManagerSettings> {
    let Some(value) = value else {
        return Ok(CacheManagerSettings::default());
    };

    let mut settings = CacheManagerSettings::default();
    let object = value
        .as_object()
        .ok_or_else(|| "cache_manager settings must be an object".to_string())?;

    if let Some(node_path) = object.get("node_path") {
        settings.node_path = Some(
            node_path
                .as_str()
                .ok_or_else(|| "cache_manager.settings.node_path must be a string".to_string())?
                .to_string(),
        );
    }

    if let Some(server_path) = object.get("server_path") {
        settings.server_path = Some(
            server_path
                .as_str()
                .ok_or_else(|| "cache_manager.settings.server_path must be a string".to_string())?
                .to_string(),
        );
    }

    if let Some(env) = object.get("env") {
        let env = env
            .as_object()
            .ok_or_else(|| "cache_manager.settings.env must be an object".to_string())?;
        for (key, value) in env {
            settings.env.insert(
                key.clone(),
                value
                    .as_str()
                    .ok_or_else(|| format!("cache_manager.settings.env.{key} must be a string"))?
                    .to_string(),
            );
        }
    }

    Ok(settings)
}

struct CacheManagerExtension;

impl zed::Extension for CacheManagerExtension {
    fn new() -> Self {
        Self
    }

    fn context_server_command(
        &mut self,
        context_server_id: &zed::ContextServerId,
        project: &zed::Project,
    ) -> zed::Result<zed::Command> {
        if context_server_id.as_ref() != "cache_manager" {
            return Err(format!("unknown context server: {context_server_id}"));
        }

        let context_settings =
            zed::settings::ContextServerSettings::for_project("cache_manager", project)?;
        let settings = parse_settings(context_settings.settings)?;

        Ok(zed::Command {
            command: settings.node_path.unwrap_or_else(|| "node".into()),
            args: vec![settings
                .server_path
                .unwrap_or_else(|| "server/cache-manager.mjs".into())],
            env: settings.env.into_iter().collect(),
        })
    }

    fn context_server_configuration(
        &mut self,
        context_server_id: &zed::ContextServerId,
        _project: &zed::Project,
    ) -> zed::Result<Option<zed::ContextServerConfiguration>> {
        if context_server_id.as_ref() != "cache_manager" {
            return Err(format!("unknown context server: {context_server_id}"));
        }

        Ok(Some(zed::ContextServerConfiguration {
            installation_instructions: "Install Node.js on your PATH, then install this repository root as a Zed dev extension. If Zed times out when connecting, configure `node_path` and `server_path` with absolute paths.".into(),
            settings_schema: r#"{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "node_path": {
      "type": "string",
      "description": "Absolute path to the Node.js executable."
    },
    "server_path": {
      "type": "string",
      "description": "Absolute path to this repository's server/cache-manager.mjs file."
    },
    "env": {
      "type": "object",
      "description": "Additional environment variables for the MCP server process.",
      "additionalProperties": {
        "type": "string"
      }
    }
  }
}"#
            .into(),
            default_settings: r#"{
  "node_path": "node",
  "server_path": "server/cache-manager.mjs",
  "env": {}
}"#
            .into(),
        }))
    }
}

zed::register_extension!(CacheManagerExtension);
