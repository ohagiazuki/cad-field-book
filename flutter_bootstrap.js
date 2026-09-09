{{flutter_js}}
{{flutter_build_config}}

for (const build of _flutter.buildConfig.builds) {
  if (build.mainJsPath && !build.mainJsPath.includes('?')) {
    build.mainJsPath += '?v=20260909-inspection-anchor-zoom235';
  }
}

_flutter.loader.load();
