/**
 * `@electron/get` 的本地应用替身。
 *
 * 为什么可以替：本地应用**总是**带着自己的 Electron 运行（打包版即应用自带的
 * `electron.exe`，开发态由启动器先确保缓存里的那份，二者都通过
 * `DSH_PET_ELECTRON_PATH` 显式传给宿主半边）。也就是说
 * `ensureElectronDownload()` 在本地应用里是一条**永远不会走到的路**——
 * 但它被 `electron-runtime.ts` 静态 import，模块图必须能加载。
 *
 * 替身不做任何网络动作（也不把 @electron/get 及其依赖打进应用包），
 * 万一真的走到这里，就明确报错告诉用户该怎么办，而不是静默失败。
 */
export async function downloadArtifact(): Promise<never> {
  throw new Error(
    'dsh-petNG 本地应用不内置 Electron 下载器：请通过启动器（npm run app / dsh-pet-ng-app）运行，' +
      '或把 DSH_PET_ELECTRON_PATH 指向一份可用的 Electron 可执行文件。',
  );
}
