import {layout, type Track} from './track'
const escape = (s:string) => s.replace(/[<>&"']/g, c => '&#'+c.charCodeAt(0)+';')
const fmt = (n:number) => n.toFixed(1)
export function poster(track:Track,title:string) {
  const {lines,km,peak,low,west,east,north,south} = layout(track)
  const hasProfile = Number.isFinite(peak)
  const height = hasProfile ? 760 : 940
  const scale = Math.min(900/(east-west || 1e-9),height/(north-south || 1e-9))
  const paths = lines.map(line => {
    const coords = line.map(p=>[fmt(540+(p.x-(east+west)/2)*scale),fmt(190+height/2-(p.y-(north+south)/2)*scale)])
    return coords.length === 1 ? '<circle cx="'+coords[0][0]+'" cy="'+coords[0][1]+'" r="5"/>' :
      '<path d="M'+coords.join(' L')+'" fill="none"/>'
  }).join('')
  const label=(x:number,y:number,size:number,str:string)=>`<text x="${x}" y="${y}" font-size="${size}">${escape(str)}</text>`
  let profile = ''
  if (hasProfile) {
    for (const line of lines) {
      let run: string[] = []
      function finish() {
        if (run.length) profile += '<path d="M'+run.join(' L')+(run.length===1?' l0.1 0':'')+'"/>'
        run=[]
      }
      for (const p of line) {
        if (p.ele === null) { finish(); continue }
        run.push(fmt(64+952*p.km/(km || 1))+','+fmt(1138-84*(p.ele-low)/(peak-low || 1)))
      }
      finish()
    }
  }
  const name = title.trim() || 'Untitled trip'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350" role="img" aria-label="Trip poster" font-family="Helvetica, Arial, sans-serif" fill="#163e38">
    <defs><pattern id="grid" width="60" height="60" patternUnits="userSpaceOnUse"><path d="M60 0H0V60" fill="none" stroke="#c6cdbd" stroke-width="1"/></pattern></defs>
    <rect width="1080" height="1350" fill="#f4f1e6"/>
    <text x="60" y="115" font-weight="700" font-size="${Math.min(76,1460/Math.max(1,name.length))}">${escape(name)}</text>
    <rect x="40" y="155" width="1000" height="${height+70}" fill="url(#grid)"/>
    <g stroke="#126c5f" fill="#126c5f" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">${paths}</g>
    ${hasProfile?label(64,1025,30,'Elevation')+'<g fill="none" stroke="#126c5f" stroke-width="5" stroke-linecap="round">'+profile+'</g>':''}
    <rect y="1180" width="1080" height="170" fill="#163e38"/>
    <g fill="#faf6e8">${label(64,1235,30,'Recorded distance')}${label(64,1310,62,fmt(km)+' km')}${hasProfile?label(590,1235,30,'Highest recorded')+label(590,1310,62,Math.round(peak)+' m'):''}</g></svg>`
}
