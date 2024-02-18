/**
 * Copyright (c) 2014-present, Facebook, Inc. All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { ParserOptions, ParserPlugin } from '@babel/parser'

const commonPlugins: ParserPlugin[] = [
  'asyncGenerators',
  'bigInt',
  'classPrivateMethods',
  'classPrivateProperties',
  'classProperties',
  'doExpressions',
  'dynamicImport',
  'estree',
  'exportDefaultFrom',
  'exportNamespaceFrom', // deprecated
  'functionBind',
  'functionSent',
  'importMeta',
  'logicalAssignment',
  'nullishCoalescingOperator',
  'numericSeparator',
  'objectRestSpread',
  'optionalCatchBinding',
  'optionalChaining',
  'partialApplication',
  'throwExpressions',
  'explicitResourceManagement', // allows use of the EcmaScript `using` keyword: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-2.html#using-declarations-and-explicit-resource-management
  'topLevelAwait',
  ['pipelineOperator', { proposal: 'smart' }],
]

export const jsPlugins: ParserPlugin[] = [
  ...commonPlugins,
  ['decorators', { decoratorsBeforeExport: true }],
  'flow',
  'jsx',
]
export const tsPlugins: ParserPlugin[] = [
  ...commonPlugins,
  'decorators-legacy',
  'typescript',
]
export const tsxPlugins: ParserPlugin[] = [
  ...commonPlugins,
  'decorators-legacy',
  'typescript',
  'jsx',
]

export function parseOptions(filePath: string, strictMode = false): ParserOptions {
  if (filePath.match(/\.ts$/i))
    return { plugins: [...tsPlugins] }

  if (filePath.match(/\.tsx$/i))
    return { plugins: [...tsxPlugins] }

  // for backward compatibility, use js parser as default unless in strict mode
  if (!strictMode || filePath.match(/\.m?jsx?$/i))
    return { plugins: [...jsPlugins] }

  throw new TypeError(
    `unable to find parser options for unrecognized file extension: ${filePath}`,
  )
}
