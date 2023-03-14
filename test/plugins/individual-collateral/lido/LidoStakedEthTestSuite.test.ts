import collateralTests from '../collateralTests'
import { CollateralFixtureContext, CollateralOpts, MintCollateralFunc } from '../pluginTestTypes'
import { resetFork, mintWSTETH } from './helpers'
import { expect } from 'chai'
import { ethers } from 'hardhat'
import { ContractFactory, BigNumber, BigNumberish } from 'ethers'
import {
  ERC20Mock,
  MockV3Aggregator,
  MockV3Aggregator__factory,
  ICollateral,
  ISTETH,
  IWSTETH,
} from '../../../../typechain'
import { bn, fp } from '../../../../common/numbers'
import { ZERO_ADDRESS } from '../../../../common/constants'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import {
  ORACLE_ERROR,
  ORACLE_TIMEOUT,
  MAX_TRADE_VOL,
  DEFAULT_THRESHOLD,
  DELAY_UNTIL_DEFAULT,
  STETH,
  WSTETH,
  ETH_USD_PRICE_FEED,
  STETH_ETH_PRICE_FEED,
  LIDO_ORACLE,
} from './constants'
import { whileImpersonating } from '../../../utils/impersonation'

/*
  Define interfaces
*/
interface WSTETHCollateralFixtureContext extends CollateralFixtureContext {
  wsteth: IWSTETH
  targetPerRefChainlinkFeed: MockV3Aggregator
}

/*
  Define deployment functions
*/

interface WSTETHCollateralOpts extends CollateralOpts {
  targetPerRefChainlinkFeed?: string
  targetPerRefChainlinkTimeout?: BigNumberish
}

export const defaultWSTETHCollateralOpts: WSTETHCollateralOpts = {
  erc20: WSTETH,
  targetName: ethers.utils.formatBytes32String('ETH'),
  rewardERC20: ZERO_ADDRESS,
  priceTimeout: ORACLE_TIMEOUT,
  chainlinkFeed: ETH_USD_PRICE_FEED,
  oracleTimeout: ORACLE_TIMEOUT,
  oracleError: ORACLE_ERROR,
  maxTradeVolume: MAX_TRADE_VOL,
  defaultThreshold: DEFAULT_THRESHOLD,
  delayUntilDefault: DELAY_UNTIL_DEFAULT,
  targetPerRefChainlinkFeed: STETH_ETH_PRICE_FEED,
  targetPerRefChainlinkTimeout: ORACLE_TIMEOUT,
}

export const deployCollateral = async (opts: WSTETHCollateralOpts = {}): Promise<ICollateral> => {
  opts = { ...defaultWSTETHCollateralOpts, ...opts }

  const WStEthCollateralFactory: ContractFactory = await ethers.getContractFactory(
    'LidoStakedEthCollateral'
  )

  const collateral = <ICollateral>await WStEthCollateralFactory.deploy(
    {
      erc20: opts.erc20,
      targetName: opts.targetName,
      rewardERC20: opts.rewardERC20,
      priceTimeout: opts.priceTimeout,
      chainlinkFeed: opts.chainlinkFeed,
      oracleError: opts.oracleError,
      oracleTimeout: opts.oracleTimeout,
      maxTradeVolume: opts.maxTradeVolume,
      defaultThreshold: opts.defaultThreshold,
      delayUntilDefault: opts.delayUntilDefault,
    },
    0,
    opts.targetPerRefChainlinkFeed,
    opts.targetPerRefChainlinkTimeout,
    { gasLimit: 2000000000 }
  )
  await collateral.deployed()
  return collateral
}

const chainlinkDefaultAnswer = bn('1800e8')
const chainlinkTargetUnitDefaultAnswer = bn('1e8')

type Fixture<T> = () => Promise<T>

const makeCollateralFixtureContext = (
  alice: SignerWithAddress,
  opts: CollateralOpts = {}
): Fixture<WSTETHCollateralFixtureContext> => {
  const collateralOpts = { ...defaultWSTETHCollateralOpts, ...opts }

  const makeCollateralFixtureContext = async () => {
    const MockV3AggregatorFactory = <MockV3Aggregator__factory>(
      await ethers.getContractFactory('MockV3Aggregator')
    )

    const chainlinkFeed = <MockV3Aggregator>(
      await MockV3AggregatorFactory.deploy(8, chainlinkDefaultAnswer)
    )

    const targetPerRefChainlinkFeed = <MockV3Aggregator>(
      await MockV3AggregatorFactory.deploy(8, chainlinkTargetUnitDefaultAnswer)
    )

    collateralOpts.chainlinkFeed = chainlinkFeed.address
    collateralOpts.targetPerRefChainlinkFeed = targetPerRefChainlinkFeed.address

    const wsteth = (await ethers.getContractAt('IWSTETH', WSTETH)) as IWSTETH
    const rewardToken = (await ethers.getContractAt('ERC20Mock', ZERO_ADDRESS)) as ERC20Mock
    const collateral = await deployCollateral(collateralOpts)
    const tokDecimals = await wsteth.decimals()

    return {
      alice,
      collateral,
      chainlinkFeed,
      wsteth,
      tok: wsteth,
      rewardToken,
      tokDecimals,
      targetPerRefChainlinkFeed,
    }
  }

  return makeCollateralFixtureContext
}

/*
  Define helper functions
*/

const mintCollateralTo: MintCollateralFunc<WSTETHCollateralFixtureContext> = async (
  ctx: WSTETHCollateralFixtureContext,
  amount: BigNumberish,
  user: SignerWithAddress,
  recipient: string
) => {
  await mintWSTETH(ctx.wsteth, user, amount, recipient)
}

const reduceTargetPerRef = async (
  ctx: WSTETHCollateralFixtureContext,
  pctDecrease: BigNumberish | undefined
) => {
  const lastRound = await ctx.targetPerRefChainlinkFeed.latestRoundData()
  const nextAnswer = lastRound.answer.sub(lastRound.answer.mul(pctDecrease!).div(100))
  await ctx.targetPerRefChainlinkFeed.updateAnswer(nextAnswer)
}

const increaseTargetPerRef = async (
  ctx: WSTETHCollateralFixtureContext,
  pctIncrease: BigNumberish | undefined
) => {
  const lastRound = await ctx.targetPerRefChainlinkFeed.latestRoundData()
  const nextAnswer = lastRound.answer.add(lastRound.answer.mul(pctIncrease!).div(100))
  await ctx.targetPerRefChainlinkFeed.updateAnswer(nextAnswer)
}

const reduceRefPerTok = async (
  ctx: WSTETHCollateralFixtureContext,
  pctDecrease: BigNumberish | undefined
) => {
  const steth = (await ethers.getContractAt('ISTETH', STETH)) as ISTETH

  // Decrease wsteth to eth exchange rate so refPerTok decreases
  const [, beaconValidators, beaconBalance] = await steth.getBeaconStat()
  const beaconBalanceLower: BigNumberish = beaconBalance.sub(
    beaconBalance.mul(pctDecrease!).div(100)
  )

  // Impersonate Lido Oracle
  await whileImpersonating(LIDO_ORACLE, async (lidoSigner) => {
    await steth.connect(lidoSigner).handleOracleReport(beaconValidators, beaconBalanceLower)
  })
}

const increaseRefPerTok = async (
  ctx: WSTETHCollateralFixtureContext,
  pctIncrease: BigNumberish | undefined
) => {
  const steth = (await ethers.getContractAt('ISTETH', STETH)) as ISTETH

  // Increase wsteth to steth exchange rate so refPerTok increases
  const [, beaconValidators, beaconBalance] = await steth.getBeaconStat()
  const beaconBalanceHigher: BigNumberish = beaconBalance.add(
    beaconBalance.mul(pctIncrease!).div(100)
  )

  // Impersonate Lido Oracle
  await whileImpersonating(LIDO_ORACLE, async (lidoSigner) => {
    await steth.connect(lidoSigner).handleOracleReport(beaconValidators, beaconBalanceHigher)
  })
}

const getExpectedPrice = async (ctx: WSTETHCollateralFixtureContext): Promise<BigNumber> => {
  // Peg Feed
  const clData = await ctx.chainlinkFeed.latestRoundData()
  const clDecimals = await ctx.chainlinkFeed.decimals()

  // Target Unit Feed
  const tgtClData = await ctx.targetPerRefChainlinkFeed.latestRoundData()
  const tgtClDecimals = await ctx.targetPerRefChainlinkFeed.decimals()

  const refPerTok = await ctx.collateral.refPerTok()

  const expectedPegPrice = clData.answer.mul(bn(10).pow(18 - clDecimals))
  const expectedTgtPrice = tgtClData.answer.mul(bn(10).pow(18 - tgtClDecimals))
  return expectedPegPrice.mul(expectedTgtPrice).mul(refPerTok).div(fp('1')).div(fp('1'))
}

/*
  Define collateral-specific tests
*/

// eslint-disable-next-line @typescript-eslint/no-empty-function
const collateralSpecificConstructorTests = () => {
  it('does not allow missing targetPerRef chainlink feed', async () => {
    await expect(
      deployCollateral({ targetPerRefChainlinkFeed: ethers.constants.AddressZero })
    ).to.be.revertedWith('missing targetPerRef feed')
  })

  it('does not allow targetPerRef oracle timeout at 0', async () => {
    await expect(deployCollateral({ targetPerRefChainlinkTimeout: 0 })).to.be.revertedWith(
      'targetPerRefChainlinkTimeout zero'
    )
  })
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
const collateralSpecificStatusTests = () => {}

// eslint-disable-next-line @typescript-eslint/no-empty-function
const beforeEachRewardsTest = async () => {}

/*
  Run the test suite
*/

const opts = {
  deployCollateral,
  collateralSpecificConstructorTests,
  collateralSpecificStatusTests,
  beforeEachRewardsTest,
  makeCollateralFixtureContext,
  mintCollateralTo,
  reduceTargetPerRef,
  increaseTargetPerRef,
  reduceRefPerTok,
  increaseRefPerTok,
  getExpectedPrice,
  itClaimsRewards: it.skip,
  itChecksTargetPerRefDefault: it.skip,
  itChecksRefPerTokDefault: it,
  itCheckPriceChanges: it,
  resetFork,
  collateralName: 'LidoStakedETH',
  chainlinkDefaultAnswer,
}

collateralTests(opts)
