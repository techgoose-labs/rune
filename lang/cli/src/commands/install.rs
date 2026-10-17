//! Install command - sets up Rune LSP, parser, and editor integration
//!
//! Grammar files are embedded at compile time so the binary is self-contained.

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

use inquire::{MultiSelect, Select};

// Embed grammar source files at compile time
const PARSER_C: &str = include_str!("../../../grammar/src/parser.c");
const SCANNER_C: &str = include_str!("../../../grammar/src/scanner.c");
// The scanner reads its constants from the registry-generated header (REQ-033).
const SCANNER_CONFIG_H: &str = include_str!("../../../grammar/src/scanner-config.h");
const PARSER_H: &str = include_str!("../../../grammar/src/tree_sitter/parser.h");
const ALLOC_H: &str = include_str!("../../../grammar/src/tree_sitter/alloc.h");
const ARRAY_H: &str = include_str!("../../../grammar/src/tree_sitter/array.h");
const HIGHLIGHTS_SCM: &str = include_str!("../../../queries/highlights.scm");

#[derive(Debug, Clone, Copy)]
pub enum Editor {
    Neovim,
    Helix,
    VSCode,
    Zed,
    Sublime,
    Emacs,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct IconTargets {
    pub yazi: bool,
    pub lf: bool,
    pub eza: bool,
    pub lsd: bool,
}

impl Editor {
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "neovim" | "nvim" | "1" => Some(Editor::Neovim),
            "helix" | "hx" | "2" => Some(Editor::Helix),
            "vscode" | "code" | "3" => Some(Editor::VSCode),
            "zed" | "4" => Some(Editor::Zed),
            "sublime" | "5" => Some(Editor::Sublime),
            "emacs" | "6" => Some(Editor::Emacs),
            _ => None,
        }
    }
}

/// Get the rune data directory
fn data_dir() -> PathBuf {
    env::var("RUNE_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::data_local_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("rune")
        })
}

/// Get the rune binary directory
fn bin_dir() -> PathBuf {
    env::var("RUNE_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".local/bin")
        })
}

/// Find the rune source directory by walking up from cwd
fn find_source_dir() -> Option<PathBuf> {
    let mut dir = env::current_dir().ok()?;
    loop {
        // Check if this looks like the rune repo
        let cargo_toml = dir.join("Cargo.toml");
        let lsp_dir = dir.join("lsp");
        if cargo_toml.exists() && lsp_dir.exists() {
            // Verify it's actually the rune repo by checking for lsp/Cargo.toml
            if lsp_dir.join("Cargo.toml").exists() {
                return Some(dir);
            }
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

/// Install Rune components with interactive prompts
pub fn install(yes: bool) -> Result<(), String> {
    let data = data_dir();
    let bin = bin_dir();

    println!("Installing Rune...");
    println!("  Data: {}", data.display());
    println!("  Bin:  {}", bin.display());
    println!();

    // Create directories
    fs::create_dir_all(&data).map_err(|e| format!("Failed to create data dir: {}", e))?;
    fs::create_dir_all(data.join("parser")).map_err(|e| format!("Failed to create parser dir: {}", e))?;
    fs::create_dir_all(data.join("queries")).map_err(|e| format!("Failed to create queries dir: {}", e))?;
    fs::create_dir_all(&bin).map_err(|e| format!("Failed to create bin dir: {}", e))?;

    // Write embedded queries
    fs::write(data.join("queries/highlights.scm"), HIGHLIGHTS_SCM)
        .map_err(|e| format!("Failed to write queries: {}", e))?;
    println!("  ✓ Queries installed");

    // Build tree-sitter parser from embedded sources
    build_parser(&data)?;

    // Build and install LSP
    build_lsp(&bin)?;

    println!();

    // Editor, shell, and icon setup
    let (editors, shell, icons) = if yes {
        (vec![Editor::Neovim], Some("zsh".to_string()), IconTargets { yazi: true, ..Default::default() })
    } else {
        (prompt_editors()?, prompt_shell()?, prompt_icons()?)
    };

    for editor in editors {
        setup_editor(editor, &data)?;
    }

    println!();

    if let Some(shell) = shell {
        setup_shell_completions(&shell)?;
    }

    println!();

    if icons.yazi { setup_yazi_icons()?; }
    if icons.lf { setup_lf_icons()?; }
    if icons.eza { setup_eza_icons()?; }
    if icons.lsd { setup_lsd_icons()?; }

    println!();
    println!("Done!");

    Ok(())
}

/// Uninstall Rune components
pub fn uninstall(editor: Option<Editor>) -> Result<(), String> {
    let data = data_dir();
    let bin = bin_dir();

    println!("Uninstalling Rune...");
    println!();

    // Remove data directory
    if data.exists() {
        fs::remove_dir_all(&data).map_err(|e| format!("Failed to remove data dir: {}", e))?;
        println!("  ✓ Data directory removed");
    }

    // Remove LSP binary
    let lsp_path = bin.join("rune-lsp");
    if lsp_path.exists() {
        fs::remove_file(&lsp_path).map_err(|e| format!("Failed to remove LSP: {}", e))?;
        println!("  ✓ LSP removed");
    }

    println!();

    // Editor cleanup
    let editor = match editor {
        Some(e) => e,
        None => prompt_editor()?,
    };

    cleanup_editor(editor)?;

    println!();
    println!("Done!");

    Ok(())
}

fn cleanup_editor(editor: Editor) -> Result<(), String> {
    match editor {
        Editor::Neovim => cleanup_neovim(),
        Editor::Helix => cleanup_helix(),
        Editor::VSCode => {
            println!("VS Code: Remove the extension manually");
            Ok(())
        }
        Editor::Zed => {
            println!("Zed: Remove rune from your languages config manually");
            Ok(())
        }
        Editor::Sublime => {
            println!("Sublime: Remove syntax files from Packages/User/ manually");
            Ok(())
        }
        Editor::Emacs => {
            println!("Emacs: Remove rune-mode from your config manually");
            Ok(())
        }
    }
}

fn cleanup_neovim() -> Result<(), String> {
    println!("Cleaning up Neovim...");

    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let nvim_site = home.join(".local/share/nvim/site");
    let nvim_config = home.join(".config/nvim");

    // Remove parser
    let parser = nvim_site.join("parser/rune.so");
    if parser.exists() {
        fs::remove_file(&parser).map_err(|e| format!("Failed to remove parser: {}", e))?;
        println!("  ✓ Parser removed");
    }

    // Remove queries
    let queries = nvim_site.join("queries/rune");
    if queries.exists() {
        fs::remove_dir_all(&queries).map_err(|e| format!("Failed to remove queries: {}", e))?;
        println!("  ✓ Queries removed");
    }

    // Remove ftdetect
    let ftdetect = nvim_config.join("after/ftdetect/rune.lua");
    if ftdetect.exists() {
        fs::remove_file(&ftdetect).map_err(|e| format!("Failed to remove ftdetect: {}", e))?;
        println!("  ✓ Filetype detection removed");
    }

    // Remove ftplugin
    let ftplugin = nvim_config.join("after/ftplugin/rune.lua");
    if ftplugin.exists() {
        fs::remove_file(&ftplugin).map_err(|e| format!("Failed to remove ftplugin: {}", e))?;
        println!("  ✓ LSP and highlights config removed");
    }

    Ok(())
}

fn cleanup_helix() -> Result<(), String> {
    println!("Cleaning up Helix...");

    let config_dir = dirs::config_dir()
        .ok_or("Could not find config directory")?
        .join("helix");

    // Remove queries
    let queries = config_dir.join("runtime/queries/rune");
    if queries.exists() {
        fs::remove_dir_all(&queries).map_err(|e| format!("Failed to remove queries: {}", e))?;
        println!("  ✓ Queries removed");
    }

    // Remove grammar source
    let grammar = config_dir.join("runtime/grammars/sources/rune");
    if grammar.exists() {
        fs::remove_dir_all(&grammar).map_err(|e| format!("Failed to remove grammar: {}", e))?;
        println!("  ✓ Grammar source removed");
    }

    // Remove theme
    let theme = config_dir.join("themes/rune.toml");
    if theme.exists() {
        fs::remove_file(&theme).map_err(|e| format!("Failed to remove theme: {}", e))?;
        println!("  ✓ Theme removed");
    }

    println!("  ! Remove rune config from languages.toml manually");

    Ok(())
}

/// Build the tree-sitter parser from embedded sources
fn build_parser(data: &PathBuf) -> Result<(), String> {
    println!("Building parser...");

    // Create temp directory for compilation
    let temp_dir = env::temp_dir().join("rune-build");
    let tree_sitter_dir = temp_dir.join("tree_sitter");
    fs::create_dir_all(&tree_sitter_dir)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;

    // Write embedded source files
    let parser_c = temp_dir.join("parser.c");
    let scanner_c = temp_dir.join("scanner.c");
    fs::write(&parser_c, PARSER_C).map_err(|e| format!("Failed to write parser.c: {}", e))?;
    fs::write(&scanner_c, SCANNER_C).map_err(|e| format!("Failed to write scanner.c: {}", e))?;
    fs::write(temp_dir.join("scanner-config.h"), SCANNER_CONFIG_H)
        .map_err(|e| format!("Failed to write scanner-config.h: {}", e))?;
    fs::write(tree_sitter_dir.join("parser.h"), PARSER_H)
        .map_err(|e| format!("Failed to write parser.h: {}", e))?;
    fs::write(tree_sitter_dir.join("alloc.h"), ALLOC_H)
        .map_err(|e| format!("Failed to write alloc.h: {}", e))?;
    fs::write(tree_sitter_dir.join("array.h"), ARRAY_H)
        .map_err(|e| format!("Failed to write array.h: {}", e))?;

    // Determine shared library flags based on OS
    let (shared_flag, output_name) = if cfg!(target_os = "macos") {
        ("-dynamiclib", "rune.so")
    } else {
        ("-shared", "rune.so")
    };

    let output_path = data.join("parser").join(output_name);

    // Build with cc
    let output = Command::new("cc")
        .arg(shared_flag)
        .arg("-o")
        .arg(&output_path)
        .arg("-fPIC")
        .arg("-O2")
        .arg(&parser_c)
        .arg(&scanner_c)
        .arg("-I")
        .arg(&temp_dir)
        .output()
        .map_err(|e| format!("Failed to run cc: {}", e))?;

    // Clean up temp files
    let _ = fs::remove_dir_all(&temp_dir);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to build parser: {}", stderr));
    }

    println!("  ✓ Parser built");
    Ok(())
}

/// Build and install the LSP from source
fn build_lsp(bin_dir: &PathBuf) -> Result<(), String> {
    let source_dir = find_source_dir()
        .ok_or("Could not find rune source directory. Run from within the rune repo.")?;

    println!("Building LSP...");

    // Build with cargo
    let output = Command::new("cargo")
        .arg("build")
        .arg("-p")
        .arg("rune-lsp")
        .arg("--release")
        .arg("--quiet")
        .current_dir(&source_dir)
        .output()
        .map_err(|e| format!("Failed to run cargo: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to build LSP: {}", stderr));
    }

    // Copy binary to bin directory
    let lsp_binary = source_dir.join("target/release/rune-lsp");
    let dest = bin_dir.join("rune-lsp");
    fs::copy(&lsp_binary, &dest)
        .map_err(|e| format!("Failed to install LSP binary: {}", e))?;

    // Ad-hoc sign on macOS to avoid security kill
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("codesign")
            .arg("-s")
            .arg("-")
            .arg(&dest)
            .output();
    }

    println!("  ✓ LSP installed");
    Ok(())
}

/// Set up shell completions by writing completion file and updating shell config
fn setup_shell_completions(shell: &str) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Could not find home directory")?;

    // Generate completion script
    let completion_script = Command::new("rune")
        .arg("completions")
        .arg(shell)
        .output()
        .map_err(|e| format!("Failed to generate completions: {}", e))?;

    if !completion_script.status.success() {
        return Err("Failed to generate completion script".to_string());
    }

    let script = String::from_utf8_lossy(&completion_script.stdout);

    match shell {
        "zsh" => {
            // Write completion file
            let comp_dir = home.join(".zsh/completions");
            fs::create_dir_all(&comp_dir)
                .map_err(|e| format!("Failed to create completions dir: {}", e))?;
            fs::write(comp_dir.join("_rune"), script.as_ref())
                .map_err(|e| format!("Failed to write completion file: {}", e))?;

            println!("  ✓ Completions installed to ~/.zsh/completions/_rune");
            println!("    Add to .zshrc: fpath=(~/.zsh/completions $fpath)");
            println!("    Then run: rm -f ~/.zcompdump* && exec zsh");
        }
        "bash" => {
            // Write completion file
            let comp_dir = home.join(".local/share/bash-completion/completions");
            fs::create_dir_all(&comp_dir)
                .map_err(|e| format!("Failed to create completions dir: {}", e))?;
            fs::write(comp_dir.join("rune"), script.as_ref())
                .map_err(|e| format!("Failed to write completion file: {}", e))?;

            println!("  ✓ Completions installed to ~/.local/share/bash-completion/completions/rune");
        }
        "fish" => {
            // Write completion file
            let comp_dir = home.join(".config/fish/completions");
            fs::create_dir_all(&comp_dir)
                .map_err(|e| format!("Failed to create completions dir: {}", e))?;
            fs::write(comp_dir.join("rune.fish"), script.as_ref())
                .map_err(|e| format!("Failed to write completion file: {}", e))?;

            println!("  ✓ Completions installed to ~/.config/fish/completions/rune.fish");
        }
        _ => return Err(format!("Unsupported shell: {}", shell)),
    }

    Ok(())
}

fn prompt_editor() -> Result<Editor, String> {
    let options = vec!["Neovim", "Helix", "VS Code", "Zed", "Sublime Text", "Emacs"];

    let selection = Select::new("Which editor would you like to configure?", options)
        .prompt()
        .map_err(|e| e.to_string())?;

    Editor::from_str(selection).ok_or_else(|| "Invalid selection".to_string())
}

fn prompt_editors() -> Result<Vec<Editor>, String> {
    let options = vec!["Neovim", "Helix", "VS Code", "Zed", "Sublime Text", "Emacs"];

    let selections = MultiSelect::new("Configure editors (space to select, enter to confirm):", options)
        .prompt()
        .map_err(|e| e.to_string())?;

    Ok(selections.into_iter().filter_map(|s| Editor::from_str(s)).collect())
}

fn prompt_shell() -> Result<Option<String>, String> {
    let options = vec!["zsh", "bash", "fish", "Skip"];

    let selection = Select::new("Configure shell completions?", options)
        .prompt()
        .map_err(|e| e.to_string())?;

    match selection {
        "Skip" => Ok(None),
        shell => Ok(Some(shell.to_string())),
    }
}

fn prompt_icons() -> Result<IconTargets, String> {
    let options = vec![
        "yazi (file manager)",
        "lf (file manager)",
        "eza (ls replacement)",
        "lsd (ls replacement)",
    ];

    let selections = MultiSelect::new("Configure file icons (space to select, enter to confirm):", options)
        .prompt()
        .map_err(|e| e.to_string())?;

    Ok(IconTargets {
        yazi: selections.iter().any(|s| s.starts_with("yazi")),
        lf: selections.iter().any(|s| s.starts_with("lf")),
        eza: selections.iter().any(|s| s.starts_with("eza")),
        lsd: selections.iter().any(|s| s.starts_with("lsd")),
    })
}

fn setup_editor(editor: Editor, data_dir: &PathBuf) -> Result<(), String> {
    match editor {
        Editor::Neovim => setup_neovim(data_dir),
        Editor::Helix => setup_helix(data_dir),
        Editor::VSCode => {
            println!("VS Code: Install the extension from editors/vscode/");
            Ok(())
        }
        Editor::Zed => {
            println!("Zed: Add rune to your languages config");
            Ok(())
        }
        Editor::Sublime => {
            println!("Sublime: Copy syntax files to Packages/User/");
            Ok(())
        }
        Editor::Emacs => {
            println!("Emacs: Add rune-mode to your config");
            Ok(())
        }
    }
}

fn setup_neovim(data_dir: &PathBuf) -> Result<(), String> {
    println!("Setting up Neovim...");

    let home = dirs::home_dir().ok_or("Could not find home directory")?;
    let nvim_site = home.join(".local/share/nvim/site");
    let nvim_config = home.join(".config/nvim");

    // Install parser
    let parser_dest = nvim_site.join("parser");
    fs::create_dir_all(&parser_dest).map_err(|e| format!("Failed to create parser dir: {}", e))?;
    let parser_src = data_dir.join("parser/rune.so");
    if parser_src.exists() {
        fs::copy(&parser_src, parser_dest.join("rune.so"))
            .map_err(|e| format!("Failed to copy parser: {}", e))?;
        println!("  ✓ Parser installed");
    }

    // Install queries
    let queries_dest = nvim_site.join("queries/rune");
    fs::create_dir_all(&queries_dest).map_err(|e| format!("Failed to create queries dir: {}", e))?;
    let queries_src = data_dir.join("queries/highlights.scm");
    if queries_src.exists() {
        fs::copy(&queries_src, queries_dest.join("highlights.scm"))
            .map_err(|e| format!("Failed to copy queries: {}", e))?;
        println!("  ✓ Queries installed");
    }

    // Create ftdetect
    let ftdetect_dir = nvim_config.join("after/ftdetect");
    fs::create_dir_all(&ftdetect_dir).map_err(|e| format!("Failed to create ftdetect dir: {}", e))?;
    fs::write(ftdetect_dir.join("rune.lua"), r#"vim.filetype.add({
  extension = { rune = "rune" },
})
"#).map_err(|e| format!("Failed to write ftdetect: {}", e))?;
    println!("  ✓ Filetype detection configured");

    // Create ftplugin with highlights and LSP (wrapped in pcall for safety)
    let ftplugin_dir = nvim_config.join("after/ftplugin");
    fs::create_dir_all(&ftplugin_dir).map_err(|e| format!("Failed to create ftplugin dir: {}", e))?;
    fs::write(ftplugin_dir.join("rune.lua"), r##"-- Register and start tree-sitter parser
local ok, err = pcall(function()
  vim.treesitter.language.register("rune", "rune")
  vim.treesitter.start()
end)
if not ok then
  vim.notify("Rune treesitter error: " .. tostring(err), vim.log.levels.WARN)
end

-- Mesa Vapor palette highlights
vim.api.nvim_set_hl(0, "@rune.tag", { fg = "#89babf" })      -- muted teal
vim.api.nvim_set_hl(0, "@rune.noun", { fg = "#8a9e7a" })     -- sage
vim.api.nvim_set_hl(0, "@rune.verb", { fg = "#9e8080" })     -- dusty mauve
vim.api.nvim_set_hl(0, "@rune.dto", { fg = "#8fb86e" })      -- moss
vim.api.nvim_set_hl(0, "@rune.builtin", { fg = "#eeeeee" })  -- cream
vim.api.nvim_set_hl(0, "@rune.boundary", { fg = "#b38585" }) -- rosewood
vim.api.nvim_set_hl(0, "@rune.fault", { fg = "#c9826a" })    -- terracotta
vim.api.nvim_set_hl(0, "@rune.comment", { fg = "#7a7070" })  -- warm gray

-- Start Rune LSP
local lsp_ok, lsp_err = pcall(function()
  vim.lsp.start({
    name = "rune",
    cmd = { vim.fn.expand("~/.local/bin/rune-lsp") },
    root_dir = vim.fn.getcwd(),
  })
end)
if not lsp_ok then
  vim.notify("Rune LSP error: " .. tostring(lsp_err), vim.log.levels.WARN)
end
"##).map_err(|e| format!("Failed to write ftplugin: {}", e))?;
    println!("  ✓ LSP and highlights configured");

    // Create icon config for nvim-web-devicons (auto-loads from after/plugin/)
    let plugin_dir = nvim_config.join("after/plugin");
    fs::create_dir_all(&plugin_dir).map_err(|e| format!("Failed to create plugin dir: {}", e))?;
    fs::write(plugin_dir.join("rune-icons.lua"), r##"-- Rune file icon for nvim-web-devicons
local ok, devicons = pcall(require, "nvim-web-devicons")
if ok then
  devicons.set_icon({
    rune = {
      icon = "ᚱ",
      color = "#89babf",
      name = "Rune"
    }
  })
end
"##).map_err(|e| format!("Failed to write icon config: {}", e))?;
    println!("  ✓ File icon configured (nvim-web-devicons)");

    Ok(())
}

fn setup_helix(data_dir: &PathBuf) -> Result<(), String> {
    println!("Setting up Helix...");

    let config_dir = dirs::config_dir()
        .ok_or("Could not find config directory")?
        .join("helix");

    // Install queries
    let queries_dest = config_dir.join("runtime/queries/rune");
    fs::create_dir_all(&queries_dest).map_err(|e| format!("Failed to create queries dir: {}", e))?;
    let queries_src = data_dir.join("queries/highlights.scm");
    if queries_src.exists() {
        fs::copy(&queries_src, queries_dest.join("highlights.scm"))
            .map_err(|e| format!("Failed to copy queries: {}", e))?;
        println!("  ✓ Queries installed");
    }

    // Create languages.toml entry
    let languages_path = config_dir.join("languages.toml");
    let languages_content = r##"
[[language]]
name = "rune"
scope = "source.rune"
file-types = ["rune"]
roots = []
comment-token = "#"
indent = { tab-width = 2, unit = "  " }
language-servers = ["rune-lsp"]

[language-server.rune-lsp]
command = "rune-lsp"
"##;

    if languages_path.exists() {
        println!("  ! languages.toml exists - add rune config manually:");
        println!("{}", languages_content);
    } else {
        fs::write(&languages_path, languages_content)
            .map_err(|e| format!("Failed to write languages.toml: {}", e))?;
        println!("  ✓ Language config created");
    }

    Ok(())
}

// Marker comments for config injection
const RUNE_BEGIN: &str = "# BEGIN RUNE CONFIG";
const RUNE_END: &str = "# END RUNE CONFIG";

fn setup_yazi_icons() -> Result<(), String> {
    println!("Setting up yazi icons...");

    // yazi uses XDG config (~/.config/yazi) on all platforms
    let config_dir = dirs::home_dir()
        .ok_or("Could not find home directory")?
        .join(".config/yazi");
    fs::create_dir_all(&config_dir).map_err(|e| format!("Failed to create yazi config dir: {}", e))?;

    let theme_path = config_dir.join("theme.toml");
    let rune_icon = r##"{ name = "rune", text = "ᚱ", fg = "#89babf" }"##;

    if theme_path.exists() {
        let content = fs::read_to_string(&theme_path)
            .map_err(|e| format!("Failed to read theme.toml: {}", e))?;

        if content.contains(r#"name = "rune""#) {
            println!("  ✓ Rune icon already configured");
        } else if content.contains("prepend_exts") {
            // Add to existing prepend_exts array
            let new_content = content.replace(
                "prepend_exts = [",
                &format!("prepend_exts = [\n  {},", rune_icon)
            );
            fs::write(&theme_path, new_content)
                .map_err(|e| format!("Failed to update theme.toml: {}", e))?;
            println!("  ✓ Added rune icon to existing prepend_exts");
        } else if content.contains("[icon]") {
            // Add prepend_exts to existing [icon] section
            let new_content = content.replace(
                "[icon]",
                &format!("[icon]\nprepend_exts = [\n  {}\n]", rune_icon)
            );
            fs::write(&theme_path, new_content)
                .map_err(|e| format!("Failed to update theme.toml: {}", e))?;
            println!("  ✓ Added rune icon to theme.toml");
        } else {
            // Append new [icon] section
            let new_content = format!("{}\n\n[icon]\nprepend_exts = [\n  {}\n]", content.trim_end(), rune_icon);
            fs::write(&theme_path, new_content)
                .map_err(|e| format!("Failed to update theme.toml: {}", e))?;
            println!("  ✓ Added rune icon to theme.toml");
        }
    } else {
        fs::write(&theme_path, format!("[icon]\nprepend_exts = [\n  {}\n]\n", rune_icon))
            .map_err(|e| format!("Failed to create theme.toml: {}", e))?;
        println!("  ✓ Created theme.toml with rune icon");
    }

    Ok(())
}

fn setup_lf_icons() -> Result<(), String> {
    println!("Setting up lf icons...");

    let config_dir = dirs::config_dir()
        .ok_or("Could not find config directory")?
        .join("lf");
    fs::create_dir_all(&config_dir).map_err(|e| format!("Failed to create lf config dir: {}", e))?;

    let icons_path = config_dir.join("icons");
    let rune_line = "*.rune ᚱ";

    if icons_path.exists() {
        let content = fs::read_to_string(&icons_path)
            .map_err(|e| format!("Failed to read icons: {}", e))?;
        if !content.contains(rune_line) {
            let new_content = format!("{}\n{}\n{}\n{}\n", content.trim_end(), RUNE_BEGIN, rune_line, RUNE_END);
            fs::write(&icons_path, new_content)
                .map_err(|e| format!("Failed to update icons: {}", e))?;
            println!("  ✓ Added rune icon");
        } else {
            println!("  ✓ Rune icon already configured");
        }
    } else {
        fs::write(&icons_path, format!("{}\n{}\n{}\n", RUNE_BEGIN, rune_line, RUNE_END))
            .map_err(|e| format!("Failed to create icons: {}", e))?;
        println!("  ✓ Created icons file with rune icon");
    }

    Ok(())
}

fn setup_eza_icons() -> Result<(), String> {
    println!("Setting up eza icons...");

    let config_dir = dirs::config_dir()
        .ok_or("Could not find config directory")?
        .join("eza");
    fs::create_dir_all(&config_dir).map_err(|e| format!("Failed to create eza config dir: {}", e))?;

    let theme_path = config_dir.join("theme.yml");

    // eza uses YAML - we'll create/update the theme file
    if theme_path.exists() {
        let content = fs::read_to_string(&theme_path)
            .map_err(|e| format!("Failed to read theme.yml: {}", e))?;
        if !content.contains("*.rune") {
            let rune_config = format!("\n{}\nicons:\n  filenames:\n    \"*.rune\": \"ᚱ\"\n{}\n", RUNE_BEGIN, RUNE_END);
            let new_content = format!("{}{}", content.trim_end(), rune_config);
            fs::write(&theme_path, new_content)
                .map_err(|e| format!("Failed to update theme.yml: {}", e))?;
            println!("  ✓ Added rune icon");
        } else {
            println!("  ✓ Rune icon already configured");
        }
    } else {
        fs::write(&theme_path, format!("{}\nicons:\n  filenames:\n    \"*.rune\": \"ᚱ\"\n{}\n", RUNE_BEGIN, RUNE_END))
            .map_err(|e| format!("Failed to create theme.yml: {}", e))?;
        println!("  ✓ Created theme.yml with rune icon");
    }

    Ok(())
}

fn setup_lsd_icons() -> Result<(), String> {
    println!("Setting up lsd icons...");

    let config_dir = dirs::config_dir()
        .ok_or("Could not find config directory")?
        .join("lsd");
    fs::create_dir_all(&config_dir).map_err(|e| format!("Failed to create lsd config dir: {}", e))?;

    let icons_path = config_dir.join("icons.yaml");

    if icons_path.exists() {
        let content = fs::read_to_string(&icons_path)
            .map_err(|e| format!("Failed to read icons.yaml: {}", e))?;
        if !content.contains("rune:") {
            let rune_config = format!("\n{}\nextension:\n  rune: ᚱ\n{}\n", RUNE_BEGIN, RUNE_END);
            let new_content = format!("{}{}", content.trim_end(), rune_config);
            fs::write(&icons_path, new_content)
                .map_err(|e| format!("Failed to update icons.yaml: {}", e))?;
            println!("  ✓ Added rune icon");
        } else {
            println!("  ✓ Rune icon already configured");
        }
    } else {
        fs::write(&icons_path, format!("{}\nextension:\n  rune: ᚱ\n{}\n", RUNE_BEGIN, RUNE_END))
            .map_err(|e| format!("Failed to create icons.yaml: {}", e))?;
        println!("  ✓ Created icons.yaml with rune icon");
    }

    Ok(())
}
