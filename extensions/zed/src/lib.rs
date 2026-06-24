use zed_extension_api as zed;

struct CacheManagerExtension;

impl zed::Extension for CacheManagerExtension {
    fn new() -> Self {
        Self
    }

    fn context_server_command(
        &mut self,
        context_server_id: &zed::ContextServerId,
        _project: &zed::Project,
    ) -> zed::Result<zed::Command> {
        if context_server_id.as_ref() != "cache_manager" {
            return Err(format!("unknown context server: {context_server_id}"));
        }

        // This extension lives at <repo>/extensions/zed, so the standalone Node
        // server is two levels up. This resolves only when the extension is
        // loaded as a Zed *dev* extension pointed at this repo (see README);
        // for a packaged install, point the command at the published npm
        // package instead.
        Ok(zed::Command {
            command: "node".into(),
            args: vec!["../../server/cache-manager.mjs".into()],
            env: vec![],
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
            installation_instructions: "Install Node.js on your PATH, then install this repository's `extensions/zed` directory as a Zed dev extension. The dev extension launches `../../server/cache-manager.mjs` from this repository checkout.".into(),
            settings_schema: r#"{
  "type": "object",
  "additionalProperties": false,
  "properties": {}
}"#
            .into(),
            default_settings: "{}".into(),
        }))
    }
}

zed::register_extension!(CacheManagerExtension);
