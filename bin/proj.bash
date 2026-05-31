# Bash / Zsh completion for `proj`.
#
# Install (bash):
#   source ~/Documents/Projects/serenity/bin/proj.bash
#
# Install (zsh — requires bashcompinit):
#   autoload -U +X bashcompinit && bashcompinit
#   source ~/Documents/Projects/serenity/bin/proj.bash
#
# Add the source line to your ~/.bashrc / ~/.zshrc.

_proj_complete() {
  local cur prev cmds opts
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  cmds="validate drift rename log history config doctor help version"
  opts="--json --quiet --no-color --version --help"

  # top-level: complete subcommands + global flags
  if [[ "$COMP_CWORD" -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "$cmds $opts" -- "$cur") )
    return 0
  fi

  # subcommand-specific flags
  case "${COMP_WORDS[1]}" in
    validate|doctor)
      COMPREPLY=( $(compgen -W "--skip-network $opts" -- "$cur") ) ;;
    drift)
      case "$prev" in
        --portfolio) COMPREPLY=( $(compgen -d -- "$cur") ) ;;
        --timeout)   COMPREPLY=() ;;
        *)           COMPREPLY=( $(compgen -W "--portfolio --timeout $opts" -- "$cur") ) ;;
      esac ;;
    rename)
      case "$prev" in
        --to|--display|--notes) COMPREPLY=() ;;
        *) COMPREPLY=( $(compgen -W "--to --display --dry-run --yes --skip-github --skip-vercel --notes $opts" -- "$cur") ) ;;
      esac ;;
    log)
      case "$prev" in
        --old|--new|--display-old|--display-new|--surfaces|--notes) COMPREPLY=() ;;
        *) COMPREPLY=( $(compgen -W "--old --new --display-old --display-new --surfaces --notes --force $opts" -- "$cur") ) ;;
      esac ;;
    history|config) COMPREPLY=( $(compgen -W "$opts" -- "$cur") ) ;;
    help)           COMPREPLY=( $(compgen -W "$cmds" -- "$cur") ) ;;
  esac
}
complete -F _proj_complete proj
