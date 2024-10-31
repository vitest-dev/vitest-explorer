import { beforeAll, describe } from 'vitest'
import { expect } from '@playwright/test'
import { test } from './helper'
import { editFile } from './tester'

// Vitst extension doesn't work with CI flag
beforeAll(() => {
  delete process.env.CI
  delete process.env.GITHUB_ACTIONS
})

test('basic', async ({ launch }) => {
  const { page, tester } = await launch({
    workspacePath: './samples/e2e',
  })

  await expect(page.getByText('No test results yet.')).toBeVisible()

  await tester.tree.expand('test')

  await tester.runAllTests()

  await expect(tester.tree.getResultsLocator()).toHaveText('2/4')
  await expect(tester.tree.getFileItem('pass.test.ts')).toHaveState('passed')
  await expect(tester.tree.getFileItem('fail.test.ts')).toHaveState('failed')
  await expect(tester.tree.getFileItem('mix.test.ts')).toHaveState('failed')
})

// test('workspaces', async ({ launch }) => {
//   const { tester } = await launch({
//     workspacePath: './samples/monorepo-vitest-workspace',
//   })
//   await tester.tree.expand('packages/react/test')

//   const basicTest = tester.tree.getFileItem('basic.test.tsx [@vitest/test-react]')

//   await expect(basicTest.locator).toBeVisible()
//   await expect(tester.tree.getFileItem('basic.test.tsx [0]').locator).toBeVisible()

//   await basicTest.run()

//   // only runs tests in a single workspace project
//   await expect(tester.tree.getResultsLocator()).toHaveText('1/1')

//   await tester.runAllTests()

//   await expect(tester.tree.getResultsLocator()).toHaveText('4/4')
// })

test('custom imba language', async ({ launch }) => {
  const { tester } = await launch({
    workspacePath: './samples/imba',
  })

  await tester.tree.expand('test')
  await tester.tree.expand('src/components')

  await tester.runAllTests()

  await expect(tester.tree.getResultsLocator()).toHaveText('3/4')
  await expect(tester.tree.getFileItem('basic.test.imba')).toHaveState('passed')
  await expect(tester.tree.getFileItem('utils.imba')).toHaveState('passed')
  await expect(tester.tree.getFileItem('counter.imba')).toHaveState('failed')
})

describe('continuous testing', () => {
  test('reruns tests on test file change', async ({ launch }) => {
    const { tester } = await launch({
      workspacePath: './samples/continuous',
    })

    await tester.tree.expand('test/imports-divide.test.ts')
    const item = tester.tree.getFileItem('imports-divide.test.ts')

    await expect(item).toHaveTests({
      divide: 'waiting',
    })

    await item.toggleContinuousRun()

    editFile('samples/continuous/test/imports-divide.test.ts', content => `${content}\n`)

    await expect(item).toHaveTests({
      divide: 'passed',
    })

    editFile('samples/continuous/src/calculator.ts', content => content.replace('a / b', '1000'))

    await expect(item).toHaveTests({
      divide: 'failed',
    })
    await item.navigate()

    const errors = await tester.errors.getInlineErrors()

    expect(errors).toEqual([
      'expected 1000 to be 2 // Object.is equality',
    ])
  })
})
