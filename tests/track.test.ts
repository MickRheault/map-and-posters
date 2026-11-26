import {expect,test} from 'bun:test'
import {layout} from '../src/track'
test('disconnected recordings omit the jump and preserve elevation gaps',()=>{
  const point=(lon:number,ele:number|null)=>({lat:0,lon,ele})
  const result=layout([[point(0,4),point(1,null)],[point(10,7),point(11,3)]])
  expect(result.km).toBeCloseTo(222.39,2)
  expect(result.lines[1][0].km).toBe(result.lines[0][1].km)
  expect(result.lines[0][1].ele).toBeNull()
  expect(result.peak).toBe(7)
})
