# Finds an installed package without assuming a repository layout.
#
# Every package lives at `node_modules/<name>` in an app, but this repository
# keeps its own packages at different depths (`packages/core`, `modules/fonts`),
# so counting parent directories can only be right in one of the two. The walk
# starts at the project root and goes up, which covers a package hoisted to an
# ancestor `node_modules` (npm workspaces) as well as one sitting beside the app
# (pnpm, a nested install).
function(rn_gpui_find_node_module package out_var)
  if(NOT RN_GPUI_PROJECT_ROOT)
    message(FATAL_ERROR
      "rn_gpui_find_node_module(${package}) needs RN_GPUI_PROJECT_ROOT, which the platform's build.rs sets")
  endif()
  set(_rn_gpui_search "${RN_GPUI_PROJECT_ROOT}")
  while(_rn_gpui_search)
    if(EXISTS "${_rn_gpui_search}/node_modules/${package}/package.json")
      set(${out_var} "${_rn_gpui_search}/node_modules/${package}" PARENT_SCOPE)
      return()
    endif()
    get_filename_component(_rn_gpui_parent "${_rn_gpui_search}" DIRECTORY)
    if(_rn_gpui_parent STREQUAL _rn_gpui_search)
      break()
    endif()
    set(_rn_gpui_search "${_rn_gpui_parent}")
  endwhile()
  message(FATAL_ERROR
    "${package} was not found in any node_modules at or above ${RN_GPUI_PROJECT_ROOT}")
endfunction()
