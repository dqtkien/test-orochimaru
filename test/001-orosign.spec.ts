import hre from 'hardhat';
import chai, { expect } from 'chai';
import { BigO, OrosignV1, OrosignMasterV1 } from '../typechain-types';
import { utils, BigNumber, ethers } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import Deployer from '../helpers/deployer';
import { dayToSec, printAllEvents } from '../helpers/functions';

// View permission only
const PERMISSION_OBSERVER = 1;
// Create a new proposal and do qick transfer
const PERMISSION_CREATE = 2;
// Allowed to sign execute transaction message and vote a proposal
const PERMISSION_VOTE = 4;
// Permission to execute the proposal
const PERMISSION_EXECUTE = 8;

const UNIT = '1000000000000000000';

const ROLE_CREATOR = PERMISSION_CREATE | PERMISSION_OBSERVER;
const ROLE_VOTER = PERMISSION_VOTE | PERMISSION_OBSERVER;
const ROLE_EXECUTOR = PERMISSION_EXECUTE | PERMISSION_OBSERVER;
const ROLE_VIEWER = PERMISSION_OBSERVER;
const ROLE_ADMIN = PERMISSION_CREATE | PERMISSION_EXECUTE | PERMISSION_VOTE | PERMISSION_OBSERVER;

async function timeTravel(secs: number) {
  await hre.network.provider.request({
    method: 'evm_increaseTime',
    params: [secs],
  });
}

async function shouldFailed(asyncFunction: () => Promise<any>): Promise<boolean> {
  let error = false;
  try {
    await asyncFunction();
    let error = false;
  } catch (e) {
    console.log((e as Error).message);
    error = true;
  }
  return error;
}

let accounts: SignerWithAddress[],
  contractMultiSig: OrosignV1,
  cloneMultiSig: OrosignV1,
  contractBigO: BigO,
  contractMultiSigMaster: OrosignMasterV1;
let deployerSigner: SignerWithAddress,
  creator: SignerWithAddress,
  voter: SignerWithAddress,
  executor: SignerWithAddress,
  viewer: SignerWithAddress,
  admin1: SignerWithAddress,
  admin2: SignerWithAddress,
  admin3: SignerWithAddress;
let chainId: number;

describe('OrosignV1', function () {
  it('OrosignV1 must be deployed correctly', async () => {
    const network = await hre.ethers.provider.getNetwork();
    chainId = network.chainId;
    accounts = await hre.ethers.getSigners();
    [deployerSigner, creator, voter, executor, viewer, admin1, admin2, admin3] = accounts;
    const deployer: Deployer = Deployer.getInstance(hre);
    deployer.connect(deployerSigner);
    contractBigO = <BigO>await deployer.contractDeploy('test/BigO', []);
    contractMultiSig = <OrosignV1>await deployer.contractDeploy('test/OrosignV1', []);

    await contractBigO.transfer(contractMultiSig.address, BigNumber.from(10000).mul(UNIT));

    printAllEvents(
      await contractMultiSig.init(
        chainId,
        [creator, voter, executor, viewer, admin1, admin2, admin3].map((e) => e.address),
        [ROLE_CREATOR, ROLE_VOTER, ROLE_EXECUTOR, ROLE_VIEWER, ROLE_ADMIN, ROLE_ADMIN, ROLE_ADMIN],
        2,
      ),
    );

    expect((await contractMultiSig.getTotalSigner()).toNumber()).to.eq(4);
  });

  it('permission should be correct', async () => {
    expect(await contractMultiSig.isUser(admin3.address)).to.eq(true);
    expect(await contractMultiSig.isPermissions(admin3.address, PERMISSION_CREATE | PERMISSION_EXECUTE)).to.eq(true);
    expect(await contractMultiSig.isPermissions(admin3.address, PERMISSION_OBSERVER)).to.eq(true);
  });

  it('should able to deploy multisig master correctly', async () => {
    const deployer: Deployer = Deployer.getInstance(hre);
    contractMultiSigMaster = <OrosignMasterV1>(
      await deployer.contractDeploy(
        'test/OrosignMasterV1',
        [],
        chainId,
        [deployerSigner.address, deployerSigner.address],
        [1, 2],
        contractMultiSig.address,
        0,
      )
    );
  });

  it('anyone could able to create new signature from multi signature master', async () => {
    const deployer: Deployer = Deployer.getInstance(hre);
    printAllEvents(
      await contractMultiSigMaster.createWallet(1, [admin1.address, admin2.address], [ROLE_ADMIN, ROLE_ADMIN], 1),
    );

    cloneMultiSig = <OrosignV1>(
      await deployer.contractAttach(
        'test/OrosignV1',
        await contractMultiSigMaster.predictWalletAddress(deployerSigner.address, 1),
      )
    );
  });

  it('admin should able to perform execute transaction to transfer native token', async () => {
    const amount = Math.round(Math.random() * 1000000);
    await deployerSigner.sendTransaction({
      to: cloneMultiSig.address,
      value: amount,
    });
    const beforeBalance = await admin1.getBalance();
    const tx = await contractMultiSig.encodePackedTransaction(chainId, 24 * 60 * 60, admin1.address, amount, '0x');
    printAllEvents(
      await cloneMultiSig
        .connect(admin2)
        .executeTransaction(
          [await admin1.signMessage(utils.arrayify(tx)), await admin2.signMessage(utils.arrayify(tx))],
          tx,
        ),
    );
    const afterBalance = await admin1.getBalance();
    console.log(beforeBalance.toString(), afterBalance.toString());
    expect(afterBalance.sub(beforeBalance).toNumber()).to.eq(amount);
  });

  it('admin should able to perform execute transaction to transfer ERC20 token', async () => {
    const amount = Math.round(Math.random() * 1000000);
    await contractBigO.connect(deployerSigner).transfer(cloneMultiSig.address, amount);
    const beforeBalance = await contractBigO.balanceOf(admin1.address);
    const tx = await cloneMultiSig.encodePackedTransaction(
      chainId,
      24 * 60 * 60,
      contractBigO.address,
      0,
      contractBigO.interface.encodeFunctionData('transfer', [admin1.address, amount]),
    );
    printAllEvents(
      await cloneMultiSig
        .connect(admin2)
        .executeTransaction(
          [await admin1.signMessage(utils.arrayify(tx)), await admin2.signMessage(utils.arrayify(tx))],
          tx,
        ),
    );
    const afterBalance = await contractBigO.balanceOf(admin1.address);
    expect(afterBalance.sub(beforeBalance).toNumber()).to.eq(amount);
  });

  it('init() can not able to be called twice', async () => {
    expect(
      await shouldFailed(async () =>
        contractMultiSig.connect(deployerSigner).init(
          chainId,
          [creator, voter, executor, viewer, admin1, admin2, admin3].map((e) => e.address),
          [ROLE_CREATOR, ROLE_VOTER, ROLE_EXECUTOR, ROLE_VIEWER, ROLE_ADMIN, ROLE_ADMIN, ROLE_ADMIN],
          2,
        ),
      ),
    ).to.eq(true);
  });
});