const edgeExports = new Set(["getStaticProps", "getEdgeProps"]);

const isDataIdentifier = (name, state) => edgeExports.has(name);

/**
 * This is a Babel plugin! It performs dead code elimination by removing anything
 * in the `getEdgeProps` or `getStaticProps` methods of pages, as well as any
 * imports from those functions.
 *
 * Mostly borrowed from Next.js's implementation:
 * @see https://github.com/vercel/next.js/blob/canary/packages/next/build/babel/plugins/next-ssg-transform.ts
 */
module.exports = function flareactEdgeTransform({ types: t }) {
  function getIdentifier(path) {
    const parentPath = path.parentPath;
    if (parentPath.type === "VariableDeclarator") {
      const pp = parentPath;
      const name = pp.get("id");
      return name.node.type === "Identifier" ? name : null;
    }
    if (parentPath.type === "AssignmentExpression") {
      const pp = parentPath;
      const name = pp.get("left");
      return name.node.type === "Identifier" ? name : null;
    }
    if (path.node.type === "ArrowFunctionExpression") {
      return null;
    }
    return path.node.id && path.node.id.type === "Identifier"
      ? path.get("id")
      : null;
  }
  function isIdentifierReferenced(ident) {
    const b = ident.scope.getBinding(ident.node.name);
    if (b === null || b === void 0 ? void 0 : b.referenced) {
      // Functions can reference themselves, so we need to check if there's a
      // binding outside the function scope or not.
      if (b.path.type === "FunctionDeclaration") {
        return !b.constantViolations
          .concat(b.referencePaths)
          // Check that every reference is contained within the function:
          .every((ref) => ref.findParent((p) => p === b.path));
      }
      return true;
    }
    return false;
  }
  function markFunction(path, state) {
    const ident = getIdentifier(path);
    if (
      (ident === null || ident === void 0 ? void 0 : ident.node) &&
      isIdentifierReferenced(ident)
    ) {
      state.refs.add(ident);
    }
  }
  function markImport(path, state) {
    const local = path.get("local");
    if (isIdentifierReferenced(local)) {
      state.refs.add(local);
    }
  }
  return {
    visitor: {
      Program: {
        enter(path, state) {
          state.refs = new Set();
          state.isPrerender = false;
          state.isServerProps = false;
          state.done = false;
          path.traverse(
            {
              VariableDeclarator(variablePath, variableState) {
                if (variablePath.node.id.type === "Identifier") {
                  const local = variablePath.get("id");
                  if (isIdentifierReferenced(local)) {
                    variableState.refs.add(local);
                  }
                } else if (variablePath.node.id.type === "ObjectPattern") {
                  const pattern = variablePath.get("id");
                  const properties = pattern.get("properties");
                  properties.forEach((p) => {
                    const local = p.get(
                      p.node.type === "ObjectProperty"
                        ? "value"
                        : p.node.type === "RestElement"
                        ? "argument"
                        : (function () {
                            throw new Error("invariant");
                          })()
                    );
                    if (isIdentifierReferenced(local)) {
                      variableState.refs.add(local);
                    }
                  });
                } else if (variablePath.node.id.type === "ArrayPattern") {
                  const pattern = variablePath.get("id");
                  const elements = pattern.get("elements");
                  elements.forEach((e) => {
                    var _a, _b;
                    let local;
                    if (
                      ((_a = e.node) === null || _a === void 0
                        ? void 0
                        : _a.type) === "Identifier"
                    ) {
                      local = e;
                    } else if (
                      ((_b = e.node) === null || _b === void 0
                        ? void 0
                        : _b.type) === "RestElement"
                    ) {
                      local = e.get("argument");
                    } else {
                      return;
                    }
                    if (isIdentifierReferenced(local)) {
                      variableState.refs.add(local);
                    }
                  });
                }
              },
              FunctionDeclaration: markFunction,
              FunctionExpression: markFunction,
              ArrowFunctionExpression: markFunction,
              ImportSpecifier: markImport,
              ImportDefaultSpecifier: markImport,
              ImportNamespaceSpecifier: markImport,
              ExportNamedDeclaration(exportNamedPath, exportNamedState) {
                const specifiers = exportNamedPath.get("specifiers");
                if (specifiers.length) {
                  specifiers.forEach((s) => {
                    if (
                      isDataIdentifier(s.node.exported.name, exportNamedState)
                    ) {
                      s.remove();
                    }
                  });
                  if (exportNamedPath.node.specifiers.length < 1) {
                    exportNamedPath.remove();
                  }
                  return;
                }
                const decl = exportNamedPath.get("declaration");
                if (decl == null || decl.node == null) {
                  return;
                }
                switch (decl.node.type) {
                  case "FunctionDeclaration": {
                    const name = decl.node.id.name;
                    if (isDataIdentifier(name, exportNamedState)) {
                      exportNamedPath.remove();
                    }
                    break;
                  }
                  case "VariableDeclaration": {
                    const inner = decl.get("declarations");
                    inner.forEach((d) => {
                      if (d.node.id.type !== "Identifier") {
                        return;
                      }
                      const name = d.node.id.name;
                      if (isDataIdentifier(name, exportNamedState)) {
                        d.remove();
                      }
                    });
                    break;
                  }
                  default: {
                    break;
                  }
                }
              },
            },
            state
          );
          if (!state.isPrerender && !state.isServerProps) {
            return;
          }
          const refs = state.refs;
          let count;
          function sweepFunction(sweepPath) {
            const ident = getIdentifier(sweepPath);
            if (
              (ident === null || ident === void 0 ? void 0 : ident.node) &&
              refs.has(ident) &&
              !isIdentifierReferenced(ident)
            ) {
              ++count;
              if (
                t.isAssignmentExpression(sweepPath.parentPath) ||
                t.isVariableDeclarator(sweepPath.parentPath)
              ) {
                sweepPath.parentPath.remove();
              } else {
                sweepPath.remove();
              }
            }
          }
          function sweepImport(sweepPath) {
            const local = sweepPath.get("local");
            if (refs.has(local) && !isIdentifierReferenced(local)) {
              ++count;
              sweepPath.remove();
              if (sweepPath.parent.specifiers.length === 0) {
                sweepPath.parentPath.remove();
              }
            }
          }
          do {
            path.scope.crawl();
            count = 0;
            path.traverse({
              // eslint-disable-next-line no-loop-func
              VariableDeclarator(variablePath) {
                if (variablePath.node.id.type === "Identifier") {
                  const local = variablePath.get("id");
                  if (refs.has(local) && !isIdentifierReferenced(local)) {
                    ++count;
                    variablePath.remove();
                  }
                } else if (variablePath.node.id.type === "ObjectPattern") {
                  const pattern = variablePath.get("id");
                  const beforeCount = count;
                  const properties = pattern.get("properties");
                  properties.forEach((p) => {
                    const local = p.get(
                      p.node.type === "ObjectProperty"
                        ? "value"
                        : p.node.type === "RestElement"
                        ? "argument"
                        : (function () {
                            throw new Error("invariant");
                          })()
                    );
                    if (refs.has(local) && !isIdentifierReferenced(local)) {
                      ++count;
                      p.remove();
                    }
                  });
                  if (
                    beforeCount !== count &&
                    pattern.get("properties").length < 1
                  ) {
                    variablePath.remove();
                  }
                } else if (variablePath.node.id.type === "ArrayPattern") {
                  const pattern = variablePath.get("id");
                  const beforeCount = count;
                  const elements = pattern.get("elements");
                  elements.forEach((e) => {
                    var _a, _b;
                    let local;
                    if (
                      ((_a = e.node) === null || _a === void 0
                        ? void 0
                        : _a.type) === "Identifier"
                    ) {
                      local = e;
                    } else if (
                      ((_b = e.node) === null || _b === void 0
                        ? void 0
                        : _b.type) === "RestElement"
                    ) {
                      local = e.get("argument");
                    } else {
                      return;
                    }
                    if (refs.has(local) && !isIdentifierReferenced(local)) {
                      ++count;
                      e.remove();
                    }
                  });
                  if (
                    beforeCount !== count &&
                    pattern.get("elements").length < 1
                  ) {
                    variablePath.remove();
                  }
                }
              },
              FunctionDeclaration: sweepFunction,
              FunctionExpression: sweepFunction,
              ArrowFunctionExpression: sweepFunction,
              ImportSpecifier: sweepImport,
              ImportDefaultSpecifier: sweepImport,
              ImportNamespaceSpecifier: sweepImport,
            });
          } while (count);
        },
      },
    },
  };
};
