const express = require('express')
const mongoose = require('mongoose')
const cookieParser = require('cookie-parser')
const dotenv = require('dotenv')
const cors = require('cors')
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const ws = require('ws')
const fs = require('fs')

// Database collections
const User = require('./models/user')
const Message = require('./models/message')


dotenv.config()
mongoose.connect(process.env.MONGO_URL);
const db = mongoose.connection;

db.on('error', (err) => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
})

db.once('open', () => {
  console.log('MongoDB connected.');
})

const jwtSecret = process.env.JWT_SECRET
const bcryptSalt = bcrypt.genSaltSync(10)



const app = express()

app.use('/uploads', express.static(__dirname + '/uploads'))

app.use(express.json())

app.use(cookieParser())

app.use(cors({
    credentials: true,
    origin: process.env.CLIENT_URL,
  }));





  async function getUserDataFromRequest(req) {

    return new Promise((resolve, reject) => {

      const token = req.cookies?.token

      if (token) {
        jwt.verify(token, jwtSecret, {}, (err, userData) => {
          if (err) throw err;
          resolve(userData);
        })

      } else {
        reject('no token');
      }
    });

  }





app.get('/test', (req,res) => {
    res.json('test ok')
})


// filtering and sending chat messages between users
app.get('/messages/:userId', async (req, res) => {

  const {userId} = req.params;
  const userData = await getUserDataFromRequest(req);
  const ourUserId = userData.userId;

  const messages = await Message.find({

    sender:{$in:[userId,ourUserId]},
    recipient:{$in:[userId,ourUserId]},
      // latest message at bottom (1 else -1)
      }).sort({createdAt: 1});

    res.json(messages);
})





app.get('/people', async (req,res) => {
  const users = await User.find({}, {'_id':1,username:1});
  res.json(users);
})





app.get('/profile', (req,res) => {
  const token = req.cookies?.token;
  if (token) {
    jwt.verify(token, jwtSecret, {}, (err, userData) => {
      if (err) throw err;
      res.json(userData);
    })
  } /* else {
    res.status(401).json('no token');
  } */
})





app.post('/login', async (req,res) => {

  const {username, password} = req.body;
  const foundUser = await User.findOne({username});

  if (foundUser) {

    const passOk = bcrypt.compareSync(password, foundUser.password)

    if (passOk) {
      jwt.sign({userId:foundUser._id,username}, jwtSecret, {}, (err, token) => {
        res.cookie('token', token, {sameSite:'none', secure:true}).json({
          id: foundUser._id,
        })
      })
    }
  }
});





app.post('/logout', (req,res) => {
  res.cookie('token', '', {sameSite:'none', secure:true}).json('ok');
});





app.post('/register', async (req,res) => {

    const {username,password} = req.body

    try {
      const hashedPassword = bcrypt.hashSync(password, bcryptSalt)
        const createdUser = await User.create({
            username: username,
            password: hashedPassword
          })

          jwt.sign({userId:createdUser._id, username}, jwtSecret, {}, (err, token) => {

            if (err) throw err
    
            //cookies will show under the name of 'token'(first param) on browser inspect
            res.cookie('token', token, {sameSite:'none', secure:true}).status(201).json({
              id: createdUser._id,
            })
        })

    }   catch(err) {
        if (err) throw err
        res.status(500).json('error')
    }
})





const server = app.listen(4000, () => {
    console.log("Server started at port 4000")
})




const wss = new ws.WebSocketServer({server})

wss.on('connection', (connection, req) => {
  // *console.log(req.headers)


  // auto show user as offline after a few seconds
  function notifyAboutOnlinePeople() {
    [...wss.clients].forEach(client => {
      client.send(JSON.stringify({
        online: [...wss.clients].map(c => ({userId:c.userId,username:c.username})),
      }));
    });
  }






  connection.isAlive = true

  connection.timer = setInterval(() => {

    connection.ping()

    connection.deathTimer = setTimeout(() => {

      connection.isAlive = false;
      clearInterval(connection.timer);
      // to save memory for ws server we terminate the connection
      connection.terminate();
      notifyAboutOnlinePeople();
      //console.log('dead');

    }, 1000)
  }, 5000)   // ping connection every 5 second







  connection.on('pong', () => {
    clearTimeout(connection.deathTimer);
  })





  const cookies = req.headers.cookie;
  // decoding token from cookie stored in browser on web socket server connection
  if (cookies) {
    // getting encoded token (Header tab (inspect))
    const tokenCookieString = cookies.split(';').find(str => str.startsWith('token='));
    // *console.log(tokenCookieString)
    if (tokenCookieString) {
      const token = tokenCookieString.split('=')[1];
      if (token) {
        jwt.verify(token, jwtSecret, {}, (err, userData) => {
          if (err) throw err;
          // * console.log(userData)
          const {userId, username} = userData;
          connection.userId = userId;
          connection.username = username;
        });
      }
    }
  }


    connection.on('message', async (message) => {
    // console.log(message, isBinary), console.log(typeof message)
    const messageData = JSON.parse(message.toString())
    const {recipient, text, file} = messageData


    let filename = null

    if (file) {

      //console.log('size', file.data.length)
      const parts = file.name.split('.')
      const ext = parts[parts.length - 1]
      filename = Date.now() + '.'+ext
      const path = __dirname + '/uploads/' + filename
      const bufferData = new Buffer.from(file.data.split(',')[1], 'base64')

      fs.writeFile(path, bufferData, () => {
      console.log('file saved:'+path)
      })
    }
    
    if (recipient && (text || file)) {

      const messageDoc = await Message.create({
        sender:connection.userId,
        recipient,
        text,    
        file: file ? filename : null,
      })
      

      Array.from(wss.clients)
      .filter(c => c.userId === recipient)
      .forEach(c => c.send(JSON.stringify({
        text,
        sender:connection.userId,
        recipient,
        file: file ? filename : null,
        _id:messageDoc._id
      })))
    }
  })
  

  notifyAboutOnlinePeople()

  // [...onject] converting objects to array
  //console.log([...wss.clients].map(c => c.username)) - consoles all usernames logged in (even from different browsers eg. brave and google or both google(diff tabs))

  // notify about online people (when someone connects)
  Array.from(wss.clients).forEach(client => {
    client.send(JSON.stringify({
      online: [...wss.clients].map(c => ({userId:c.userId,username:c.username})),
    }));
  })
})

  wss.on('close', data => {
    console.log('disconnect', data)
  })