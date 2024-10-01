import koa from 'koa'
import koaRouter from 'koa-router'
import bodyParser from 'koa-bodyparser'
import serve from 'koa-static'
import { join } from 'path';
import {setUrl} from '@/action/setUrl.js'
import {login} from '@/action/login.js'
import {cacheAllContact} from '@/action/contact'
import {setCached} from '@/action/common'
import {CheckOnline} from '@/api/login'
import { getLocalIPAddress, compareMemberLists, getAttributesFromXML } from "@/utils/index.js";
import {Message} from '@/class/MESSAGE.js'
import {Contact} from '@/class/CONTACT.js'
import {Room} from '@/class/ROOM.js'
import { botEmitter, roomEmitter } from '@/bot.js'
import { getAppId } from '@/utils/auth.js';
import {db} from '@/sql/index.js'
import {MessageType} from '@/type/MessageType'
import {RoomInvitation} from '@/class/ROOMINVITATION.js'
import {getRoomLiveInfo} from '@/action/room.js'
import { Friendship } from '@/class/FRIENDSHIP';
export const bot = botEmitter

const ip = getLocalIPAddress()
const app = new koa()
const router = new koaRouter()
// 使用 bodyParser 解析 POST 请求的 body

export const startServe = (option) => {
  // 启动服务
  let callBackUrl = `http://${ip}:${option.port}${option.route}`
  if(option.proxy){
    callBackUrl = `${option.proxy}${option.route}`
  }
  // 设置文件保存目录
  app.use(serve(join(process.cwd(), option.static)))

  // 定义一个接口，能够同时处理 GET 和 POST 请求
  router.post(option.route, async (ctx) => {
    try{
      const body = ctx.request.body; // 获取 POST 请求的 body 数据
      if(option.debug){
        console.log(body);
      }
      
      if(body && body.TypeName === 'Offline'){
        console.log('掉线咯！！！')
        process.exit(1);
      }
      
      bot.emit('all', body)
      // 判断是否是微信消息
      if(body.Appid && body.TypeName === 'AddMsg'){ // 大部分消息类型都为 AddMsg
        // 消息hanlder
        const msg = new Message(body)
        // 发送消息
        
        const type = msg.type()
        if(type === MessageType.RoomInvitation){ // 群邀请
          let obj = msg.getXml2Json(msg.text())
          obj.formId = msg.fromId
          bot.emit(`room-invite`, new RoomInvitation(obj))
        }else if(type === MessageType.AddFriend){ // 好友请求
          let obj = getAttributesFromXML(msg.text())
          bot.emit('friendship', new Friendship(obj))
        }else{
          bot.emit('message', msg)
        }
      }else if(body && body.TypeName === 'ModContacts'){ // 好友消息， 群信息变更
        // 消息hanlder
        const id = body.Data.UserName.string
        if(id.endsWith('@chatroom')){ // 群消息
          const oldInfo = db.findOneByChatroomId(id)
          if(body.Data.SmallHeadImgUrl){ // 头像变动表示群成员变动
            const newInfo = await getRoomLiveInfo(id)
            const obj = compareMemberLists(oldInfo.memberList, newInfo.memberList)
            if(obj.added.length > 0){
              obj.added.map((item) => {
                const member = new Contact(item)
                roomEmitter.emit(`join:${id}`, new Room(newInfo), member, member.inviterUserName)
              })
              
            }
            if(obj.removed.length > 0){
              obj.removed.map((item) => {
                const member = new Contact(item)
                roomEmitter.emit(`leave:${id}`, new Room(newInfo), member)
              })
            }
            db.updateRoom(id, newInfo)
          }
          if(body.Data.NickName.string !== oldInfo.nickName){ // 群名称变动
            const newInfo = await getRoomLiveInfo(id)
            roomEmitter.emit(`topic:${id}`, new Room(newInfo), body.Data.NickName.string, oldInfo.nickName)
            db.updateRoom(id, newInfo)
          }
        }
      }



      // "TypeName": "ModContacts", 好友消息， 群信息变更 
      // "TypeName": "DelContacts" 删除好友
      // "TypeName": "DelContacts" 退出群聊
      
    }catch(e){
      console.error(e)
    }
    ctx.body = "SUCCESS";
  }).get(option.route, (ctx) => {
    const query = ctx.request.query; // 获取 GET 请求的 query 参数
    console.log('GET 请求的数据:', query);
    ctx.body = "SUCCESS";
  });
  app.use(bodyParser());
  app.use(router.routes())
  app.use(router.allowedMethods())
  
  return new Promise((resolve, reject) => {
    app.listen(option.port, async (err) => {
      if(err){
        reject(err)
        process.exit(1);
      }

      try{
        const isOnline = await CheckOnline({
          appId: getAppId()
        })
        if(isOnline.ret === 200 && isOnline.data === false){
          console.log('未登录')
          const loginRes = await login()
          if(!loginRes){
            console.log('登录失败')
            process.exit(1);
          }
        }
        setCached(false)
        if(option.use_cache){ // 使用缓存 且不存在数据库文件 创建本地数据库
          setCached(true)
          if(!db.exists(getAppId()+'.db')){
            console.log('启用缓存 但不存在数据库文件 创建本地数据库')
            db.connect(getAppId()+'.db')
            // 创建表
            db.createContactTable()
            db.createRoomTable()
            // 缓存所有联系人 并保存到本地数据库
            await cacheAllContact()
          }else{
            db.connect(getAppId()+'.db')
            console.log('启用缓存 且存在数据库文件 跳过缓存')
          }
        }

        const res = await setUrl(callBackUrl)
        if(res.ret === 200){
          console.log(`设置回调地址为：${callBackUrl}`)
          console.log('服务启动成功')
          resolve({app, router})
        }else{
          console.log('回调地址设置失败，请确定gewechat能访问到回调地址网络')
          reject(res)
          process.exit(1);
        }
      }catch(e){
        console.log('服务启动失败')
        console.error(e)
        reject(e)
        process.exit(1);
      }
    }).on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(`Port ${option.port} is already in use. Please use a different port.`);
      } else {
        reject(`Server error: ${err}`);
      }
    });
  })
}
