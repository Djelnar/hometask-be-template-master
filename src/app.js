const express = require('express')
const bodyParser = require('body-parser')
const Sequelize = require('sequelize')
const { sequelize } = require('./model')
const { getProfile } = require('./middleware/getProfile')
const app = express()
app.use(bodyParser.json())
app.set('sequelize', sequelize)
app.set('models', sequelize.models)

const { or, and, gt, lt, not, gte, lte } = Sequelize.Op

const profileTypeToIdKey = {
  client: 'ClientId',
  contractor: 'ContractorId',
}
app.get('/contracts/:id', getProfile, async (req, res) => {
  const { Contract } = req.app.get('models')
  const { id } = req.params
  const { id: profileId, type: profileType } = req.profile
  const contract = await Contract.findOne({
    where: {
      id,
      [profileTypeToIdKey[profileType]]: profileId,
    },
  })

  if (!contract) {
    return res.status(404).end()
  }
  return res.json(contract)
})

app.get('/contracts', getProfile, async (req, res) => {
  const { Contract } = req.app.get('models')
  const { id } = req.params
  const { id: profileId, type: profileType } = req.profile
  const contracts = await Contract.findAll({
    where: {
      status: {
        [not]: 'terminated',
      },
      [profileTypeToIdKey[profileType]]: profileId,
    },
  })

  if (!contracts) {
    return res.status(404).end()
  }
  return res.json(contracts)
})

app.get('/jobs/unpaid', getProfile, async (req, res) => {
  const { Job, Contract } = req.app.get('models')
  const { id } = req.params
  const { id: profileId, type: profileType } = req.profile
  const unpaidJobs = await Job.findAll({
    include: [
      {
        model: Contract,
        where: {
          status: 'in_progress',
          [profileTypeToIdKey[profileType]]: profileId,
        },
        required: true,
      },
    ],
    where: {
      paid: {
        [not]: true,
      },
    },
  })

  if (!unpaidJobs) {
    return res.status(404).end()
  }
  return res.json(unpaidJobs)
})

app.post('/jobs/:job_id/pay', getProfile, async (req, res) => {
  const { Job, Contract, Profile } = req.app.get('models')
  const { job_id } = req.params
  const { id: profileId, type: profileType } = req.profile
  if (profileType !== 'client') {
    return res.status(403).end('Only clients can pay for jobs')
  }

  try {
    const result = await sequelize.transaction(async (t) => {
      const unpaidJobToPay = await Job.findOne({
        include: [
          {
            model: Contract,
            where: {
              status: 'in_progress',
              ClientId: profileId,
            },
            required: true,
            include: [
              {
                model: Profile,
                as: 'Client',
                where: {
                  id: profileId,
                },
                required: true,
              },
            ],
          },
        ],
        where: {
          id: job_id,
          paid: {
            [not]: true,
          },
        },
        transaction: t,
      })

      if (!unpaidJobToPay) {
        throw {
          code: 404,
          message: 'Job not found',
        }
      }
      if (unpaidJobToPay.Contract.Client.balance < unpaidJobToPay.price) {
        throw {
          code: 409,
          message: 'Balance is not sufficient',
        }
      }

      const { price } = unpaidJobToPay
      const [[, updatedClient]] = await Profile.decrement(
        {
          balance: price,
        },
        {
          where: {
            id: unpaidJobToPay.Contract.ClientId,
            balance: {
              [gte]: price,
            },
          },
          transaction: t,
        },
      )
      if (!updatedClient) {
        throw {
          code: 409,
          message: 'Balance is not sufficient',
        }
      }
      const [[, updatedContractor]] = await Profile.increment(
        {
          balance: price,
        },
        {
          where: {
            id: unpaidJobToPay.Contract.ContractorId,
          },
          transaction: t,
        },
      )
      if (!updatedContractor) {
        throw {
          code: 500,
          message: 'Error updating contractor',
        }
      }

      unpaidJobToPay.paid = true
      unpaidJobToPay.paymentDate = new Date()
      await unpaidJobToPay.save({ transaction: t })
      await unpaidJobToPay.reload({ transaction: t })
      return unpaidJobToPay
    })

    return res.json(result)
  } catch (error) {
    return res.status(error?.code ?? 500).end(error?.message ?? 'Unknown error')
  }
})

app.post('/balances/deposit', getProfile, async (req, res) => {
  const { Profile, Job, Contract } = req.app.get('models')
  const { id: profileId, type: profileType } = req.profile
  const depositAmount = parseFloat(req.query.amount)
  if (profileType !== 'client') {
    return res.status(403).end('Only clients can deposit money')
  }

  try {
    const result = await sequelize.transaction(async (t) => {
      const unpaidJobsPriceSum = await Job.sum('price', {
        include: [
          {
            model: Contract,
            where: {
              status: 'in_progress',
              ClientId: profileId,
            },
            required: true,
          },
        ],
        where: {
          paid: {
            [not]: true,
          },
        },
        transaction: t,
      })

      if (depositAmount > unpaidJobsPriceSum / 4) {
        throw {
          code: 409,
          message: 'You can only deposit up to 25% of total unpaid jobs amount',
        }
      }

      await req.profile.increment(
        {
          balance: depositAmount,
        },
        {
          transaction: t,
        },
      )

      await req.profile.reload({ transaction: t })

      return req.profile
    })

    return res.json(result)
  } catch (error) {
    return res.status(error?.code ?? 500).end(error?.message ?? 'Unknown error')
  }
})

app.get('/admin/best-profession', async (req, res) => {
  const { Profile, Contract, Job } = req.app.get('models')
  const { start, end } = req.query
  const whereCondition = {
    paid: true,
  }
  if (start) {
    whereCondition.paymentDate = whereCondition.paymentDate ?? {}
    whereCondition.paymentDate[gte] = new Date(start)
  }
  if (end) {
    whereCondition.paymentDate = whereCondition.paymentDate ?? {}
    whereCondition.paymentDate[lte] = new Date(end)
  }
  const topContractor = await Job.findOne({
    group: Sequelize.col('Contract.Contractor.profession'),
    order: [[Sequelize.fn('SUM', Sequelize.col('price')), 'DESC']],
    attributes: [
      [Sequelize.col('Contract.Contractor.profession'), 'profession'],
    ],
    include: [
      {
        model: Contract,
        required: true,
        attributes: [],
        include: [
          {
            model: Profile,
            as: 'Contractor',
            attributes: [],
            required: true,
          },
        ],
      },
    ],
    where: whereCondition,
  })

  if (!topContractor) {
    return res.status(404).end()
  }
  res.json(topContractor)
})

app.get('/admin/best-clients', async (req, res) => {
  const { Profile, Contract, Job } = req.app.get('models')
  const { start, end, limit = 2 } = req.query
  const whereCondition = {
    paid: true,
  }
  if (start) {
    whereCondition.paymentDate = whereCondition.paymentDate ?? {}
    whereCondition.paymentDate[gte] = new Date(start)
  }
  if (end) {
    whereCondition.paymentDate = whereCondition.paymentDate ?? {}
    whereCondition.paymentDate[lte] = new Date(end)
  }
  const topClients = await Job.findAll({
    group: Sequelize.col('Contract.Client.id'),
    order: [['paid', 'DESC']],
    attributes: [
      [Sequelize.col('Contract.Client.id'), 'id'],
      [
        Sequelize.fn(
          'CONCAT',
          Sequelize.col('firstName'),
          ' ',
          Sequelize.col('lastName'),
        ),
        'fullName',
      ],
      [Sequelize.fn('SUM', Sequelize.col('price')), 'paid'],
    ],
    include: [
      {
        model: Contract,
        required: true,
        attributes: [],
        include: [
          {
            model: Profile,
            as: 'Client',
            attributes: [],
            required: true,
          },
        ],
      },
    ],
    where: whereCondition,
    limit: parseInt(limit),
  })

  if (!topClients) {
    return res.status(404).end()
  }
  res.json(topClients)
})

module.exports = app
