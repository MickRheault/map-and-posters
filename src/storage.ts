import type { Project } from './project'

let connection: Promise<IDBDatabase> | undefined
function openStore(): Promise<IDBDatabase> {
  if (!connection) {
    connection = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('map-and-posters', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('projects')
      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => { db.close(); connection = undefined }
        resolve(db)
      }
      request.onerror = () => reject(request.error)
    }).catch(error => { connection = undefined; throw error })
  }
  return connection
}

export async function loadProject(): Promise<Project | undefined> {
  const db = await openStore()
  return new Promise((resolve,reject) => {
    const request = db.transaction('projects').objectStore('projects').get('current')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function saveProject(project: Project): Promise<void> {
  const db = await openStore()
  return new Promise((resolve,reject) => {
    const transaction = db.transaction('projects','readwrite')
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error || new Error('Local save was interrupted.'))
    transaction.onerror = () => reject(transaction.error)
    transaction.objectStore('projects').put(project,'current')
  })
}
