//! Rune CLI - Generate scaffolded code from .rune specs

use std::io;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{CommandFactory, Parser, Subcommand, ValueHint};
use clap_complete::{generate, Shell};

use rune_cli::commands;

#[derive(Parser)]
#[command(name = "rune-syntax")]
#[command(about = "Rune syntax tooling (format, editor install) — internal helper invoked by the `rune` CLI; checking and codegen live in the rune engine")]
#[command(version)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Format a .rune file
    Format {
        /// Input .rune file
        #[arg(value_hint = ValueHint::FilePath)]
        input: PathBuf,

        /// Check if file is formatted without modifying it
        #[arg(long)]
        check: bool,
    },

    /// Install Rune (LSP, parser, editor integration)
    Install {
        /// Skip interactive prompts (defaults to neovim, zsh, yazi)
        #[arg(short = 'y', long = "yes")]
        yes: bool,
    },

    /// Uninstall Rune (remove LSP, parser, editor integration)
    Uninstall {
        /// Editor to unconfigure
        #[arg(short, long, value_parser = ["neovim", "helix", "vscode", "zed", "sublime", "emacs"])]
        editor: Option<String>,
    },

    /// Generate shell completions
    Completions {
        /// Shell to generate completions for
        #[arg(value_enum)]
        shell: Shell,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();

    match cli.command {
        Commands::Format { input, check } => {
            match commands::format(&input, check) {
                Ok(is_formatted) => {
                    if check {
                        if is_formatted {
                            println!("File is properly formatted");
                            ExitCode::SUCCESS
                        } else {
                            println!("File needs formatting");
                            ExitCode::FAILURE
                        }
                    } else {
                        println!("Formatted {}", input.display());
                        ExitCode::SUCCESS
                    }
                }
                Err(e) => {
                    eprintln!("Error: {}", e);
                    ExitCode::FAILURE
                }
            }
        }

        Commands::Install { yes } => {
            match commands::install(yes) {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => {
                    eprintln!("Error: {}", e);
                    ExitCode::FAILURE
                }
            }
        }

        Commands::Uninstall { editor } => {
            let editor = editor.and_then(|e| commands::Editor::from_str(&e));
            match commands::uninstall(editor) {
                Ok(()) => ExitCode::SUCCESS,
                Err(e) => {
                    eprintln!("Error: {}", e);
                    ExitCode::FAILURE
                }
            }
        }

        Commands::Completions { shell } => {
            generate(shell, &mut Cli::command(), "rune-syntax", &mut io::stdout());
            ExitCode::SUCCESS
        }
    }
}
